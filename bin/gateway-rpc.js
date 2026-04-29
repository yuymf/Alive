#!/usr/bin/env node
'use strict';

/**
 * Gateway RPC Helper — connects to the openclaw gateway WebSocket directly
 * and executes a single RPC request. Bypasses the CLI which hangs on Windows.
 *
 * Usage:
 *   node gateway-rpc.js <method> [json-params] [--timeout ms]
 *
 * Example:
 *   node gateway-rpc.js cron.list '{}'
 *   node gateway-rpc.js cron.add '{"name":"test","cron":"0 * * * *",...}'
 *
 * Output: JSON result on stdout, errors on stderr (exit code 1).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ── Configuration ──────────────────────────────────────────────────────────

const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const DEVICE_IDENTITY_PATH = path.join(OPENCLAW_DIR, 'identity', 'device.json');
const DEVICE_AUTH_PATH = path.join(OPENCLAW_DIR, 'identity', 'device-auth.json');
const CONFIG_PATH = path.join(OPENCLAW_DIR, 'openclaw.json');

// ── Ed25519 helpers ────────────────────────────────────────────────────────

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function base64UrlEncode(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function base64UrlDecode(input) {
  const normalized = input.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, 'base64');
}

function derivePublicKeyRaw(publicKeyPem) {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function publicKeyRawBase64UrlFromPem(publicKeyPem) {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), key));
}

function buildDeviceAuthPayloadV3({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce, platform, deviceFamily }) {
  const scopeStr = scopes.join(',');
  const tokenStr = token ?? '';
  const platformStr = (platform || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  const familyStr = (deviceFamily || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return ['v3', deviceId, clientId, clientMode, role, scopeStr, String(signedAtMs), tokenStr, nonce, platformStr, familyStr].join('|');
}

// ── Gateway port resolution ────────────────────────────────────────────────

function resolveGatewayPort() {
  // Try openclaw.json first
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (cfg.gateway?.remote?.port) return cfg.gateway.remote.port;
      if (cfg.gateway?.port) return cfg.gateway.port;
    } catch { /* ignore */ }
  }
  // Default port
  return 23001;
}

// ── Device identity loading ────────────────────────────────────────────────

function loadDeviceIdentity() {
  if (!fs.existsSync(DEVICE_IDENTITY_PATH)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(DEVICE_IDENTITY_PATH, 'utf8'));
    if (raw?.version === 1 && raw.deviceId && raw.publicKeyPem && raw.privateKeyPem) {
      return raw;
    }
  } catch { /* ignore */ }
  return null;
}

function loadDeviceAuthToken() {
  if (!fs.existsSync(DEVICE_AUTH_PATH)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(DEVICE_AUTH_PATH, 'utf8'));
    return raw?.tokens?.operator?.token ?? null;
  } catch { /* ignore */ }
  return null;
}

// ── WebSocket RPC client ───────────────────────────────────────────────────

async function callGatewayRPC(method, params, timeoutMs) {
  // Find WebSocket implementation — prefer ws package (has .on() API) over built-in (addEventListener)
  let WebSocketClass;
  let wsStyle = 'on'; // 'on' for ws package, 'addEventListener' for built-in

  const wsLoaders = [
    // 1) ws package from openclaw's node_modules (resolve from openclaw binary location)
    () => {
      const clawBin = whichSync('openclaw');
      if (!clawBin) return null;
      // openclaw.cmd is typically in node_modules/.bin/ — go up to find ws
      const candidates = [
        path.join(path.dirname(clawBin), '..', 'node_modules', 'ws'),
        path.join(path.dirname(clawBin), '..', 'openclaw', 'node_modules', 'ws'),
      ];
      for (const wsPath of candidates) {
        if (fs.existsSync(path.join(wsPath, 'index.js'))) return require(wsPath);
      }
      return null;
    },
    // 2) Try known paths (common Windows install locations)
    () => { try { return require('C:/openclaw/openclaw/source/node_modules/ws'); } catch { return null; } },
    // 3) Try npm global
    () => {
      try {
        const npmRoot = require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim();
        return require(path.join(npmRoot, 'ws'));
      } catch { return null; }
    },
  ];

  for (const loader of wsLoaders) {
    try {
      const mod = loader();
      if (mod) {
        // ws package exports WebSocket class directly as the module (typeof === 'function')
        WebSocketClass = (typeof mod === 'function') ? mod : (mod.WebSocket || mod.default);
        if (typeof WebSocketClass === 'function') break;
        WebSocketClass = undefined;
      }
    } catch { /* continue */ }
  }

  // Fall back to built-in WebSocket (Node.js 22+) — needs addEventListener adapter
  if (!WebSocketClass && globalThis.WebSocket) {
    WebSocketClass = globalThis.WebSocket;
    wsStyle = 'addEventListener';
  }

  if (!WebSocketClass) {
    throw new Error('No WebSocket implementation available. Need Node.js 22+ or ws package.');
  }

  const port = resolveGatewayPort();
  const url = `ws://127.0.0.1:${port}/ws`;
  const deviceIdentity = loadDeviceIdentity();
  const deviceToken = loadDeviceAuthToken();

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error(`gateway RPC timeout (${timeoutMs}ms) for ${method}`));
      }
    }, timeoutMs);

    let ws;
    try {
      ws = new WebSocketClass(url);
    } catch (e) {
      clearTimeout(timer);
      reject(new Error(`Failed to create WebSocket: ${e.message}`));
      return;
    }

    let connectNonce = null;
    let authenticated = false;

    // Unified event helpers — work with both ws package (.on) and built-in (addEventListener)
    function onOpen() { /* wait for challenge */ }

    function onMessage(rawData) {
      // Built-in WebSocket delivers MessageEvent with .data; ws delivers Buffer/string directly
      const raw = rawData?.data ?? rawData;
      const data = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      let parsed;
      try { parsed = JSON.parse(data); } catch { return; }

      // Handle challenge event
      if (parsed.type === 'event' && parsed.event === 'connect.challenge') {
        connectNonce = parsed.payload?.nonce;
        if (!connectNonce) {
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch { /* ignore */ }
          reject(new Error('Gateway challenge missing nonce'));
          return;
        }

        // Build connect request
        const signedAtMs = Date.now();
        const role = 'operator';
        const scopes = ['operator.admin', 'operator.read', 'operator.write'];
        const clientId = 'cli';
        const clientMode = 'cli';
        const platform = process.platform;

        const connectParams = {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: clientId,
            displayName: 'Alive Installer',
            version: '1.0.0',
            platform,
            mode: clientMode,
          },
          caps: [],
          auth: deviceToken ? { deviceToken } : undefined,
          role,
          scopes,
        };

        // Add device identity if available
        if (deviceIdentity) {
          const payload = buildDeviceAuthPayloadV3({
            deviceId: deviceIdentity.deviceId,
            clientId,
            clientMode,
            role,
            scopes,
            signedAtMs,
            token: deviceToken ?? null,
            nonce: connectNonce,
            platform,
          });
          const signature = signDevicePayload(deviceIdentity.privateKeyPem, payload);
          connectParams.device = {
            id: deviceIdentity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(deviceIdentity.publicKeyPem),
            signature,
            signedAt: signedAtMs,
            nonce: connectNonce,
          };
        }

        // Send connect request
        const connectFrame = {
          type: 'req',
          id: crypto.randomUUID(),
          method: 'connect',
          params: connectParams,
        };
        ws.send(JSON.stringify(connectFrame));
        return;
      }

      // Handle response (type is "res", not "resp")
      if (parsed.type === 'res') {
        // Connect response
        if (!authenticated && parsed.ok) {
          authenticated = true;
          // Now send the actual RPC request
          const rpcFrame = {
            type: 'req',
            id: crypto.randomUUID(),
            method,
            params,
          };
          ws.send(JSON.stringify(rpcFrame));
          return;
        }

        // Connect error
        if (!authenticated && !parsed.ok) {
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch { /* ignore */ }
          reject(new Error(`Gateway connect failed: ${parsed.error?.message ?? JSON.stringify(parsed.error)}`));
          return;
        }

        // RPC response
        if (authenticated) {
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch { /* ignore */ }
          if (parsed.ok) {
            resolve(parsed.payload);
          } else {
            reject(new Error(`Gateway RPC error for ${method}: ${parsed.error?.message ?? JSON.stringify(parsed.error)}`));
          }
          return;
        }
      }
    }

    function onError(err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`WebSocket error: ${err?.message || err}`));
      }
    }

    function onClose() {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('WebSocket closed before response'));
      }
    }

    // Register events — handle both ws package and built-in WebSocket APIs
    if (wsStyle === 'addEventListener') {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
    } else {
      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);
    }
  });
}

// ── whichSync helper ───────────────────────────────────────────────────────

function whichSync(bin) {
  try {
    const cmd = os.platform() === 'win32' ? `where ${bin}` : `which ${bin}`;
    const result = require('child_process').execSync(cmd, { encoding: 'utf8', timeout: 2000, stdio: 'pipe' }).trim();
    return result.split('\n')[0].trim();
  } catch {
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node gateway-rpc.js <method> [json-params] [--timeout ms]');
    process.exit(1);
  }

  const method = args[0];
  let params = {};
  let timeoutMs = 15000;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--timeout' && i + 1 < args.length) {
      timeoutMs = parseInt(args[i + 1], 10) || 15000;
      i++;
    } else {
      try {
        params = JSON.parse(args[i]);
      } catch {
        console.error(`Invalid JSON params: ${args[i]}`);
        process.exit(1);
      }
    }
  }

  try {
    const result = await callGatewayRPC(method, params, timeoutMs);
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
