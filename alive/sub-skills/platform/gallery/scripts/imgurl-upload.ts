/**
 * imgurl-upload.ts
 * Upload images to ImgURL (https://www.imgurl.org) for public hosting.
 * Migrated from skill/scripts/imgurl-upload.ts — no changes needed.
 *
 * API: POST /api/v3/upload (multipart/form-data)
 * Auth: Bearer token via IMGURL_TOKEN env var
 */

import * as fs from 'fs';
import * as path from 'path';

const IMGURL_BASE = 'https://www.imgurl.org';
const UPLOAD_ENDPOINT = `${IMGURL_BASE}/api/v3/upload`;

interface ImgURLResponse {
  code: number;
  msg: string;
  data: {
    imgid: string;
    path: string;
    url: string;
    thumbnail_url: string;
    width: number;
    height: number;
    filename: string;
    size: number;
  } | null;
}

export interface UploadResult {
  url: string;
  thumbnailUrl: string;
  imgid: string;
  width: number;
  height: number;
  size: number;
}

/**
 * Upload a local image file to ImgURL and return the public URL.
 */
export async function uploadToImgURL(localPath: string): Promise<UploadResult> {
  // E2E mock: return fake result without network call
  if (process.env.E2E_MOCK_IMGURL === '1') {
    const filename = path.basename(localPath);
    return {
      url: `https://mock.imgurl.org/i/${filename}`,
      thumbnailUrl: `https://mock.imgurl.org/t/${filename}`,
      imgid: `mock_${Date.now()}`,
      width: 1024,
      height: 1365,
      size: fs.existsSync(localPath) ? fs.statSync(localPath).size : 0,
    };
  }

  const token = process.env.IMGURL_TOKEN;
  if (!token) throw new Error('IMGURL_TOKEN not set');

  if (!fs.existsSync(localPath)) {
    throw new Error(`Image not found: ${localPath}`);
  }

  const fileBuffer = fs.readFileSync(localPath);
  const filename = path.basename(localPath);

  // Build multipart/form-data using native Blob/FormData (Node 18+)
  const blob = new Blob([fileBuffer], { type: getMimeType(filename) });
  const formData = new FormData();
  formData.append('file', blob, filename);

  const res = await fetch(UPLOAD_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`ImgURL upload HTTP ${res.status}: ${await res.text()}`);
  }

  const body = await res.json() as ImgURLResponse;

  if (body.code !== 200 || !body.data) {
    throw new Error(`ImgURL upload failed: ${body.msg}`);
  }

  return {
    url: body.data.url,
    thumbnailUrl: body.data.thumbnail_url,
    imgid: body.data.imgid,
    width: body.data.width,
    height: body.data.height,
    size: body.data.size,
  };
}

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  };
  return mimeMap[ext] ?? 'image/png';
}
