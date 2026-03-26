#!/usr/bin/env python3
"""
instagram-bridge.py
Python bridge for Instagram operations via instagrapi.
Called from TypeScript via child_process.execFile.

Subcommands:
  upload_photo     --image <path> --caption <text>
  upload_album     --images <json_array> --caption <text>
  get_media_insights --media-pk <pk>
  get_media_info   --media-pk <pk>
  hashtag_top      --name <tag> --amount <n>
  hashtag_recent   --name <tag> --amount <n>
  get_comments     --media-pk <pk> --amount <n>
  reply_comment    --media-pk <pk> --comment-pk <pk> --text <text>
  post_comment     --media-pk <pk> --text <text>
  get_user_feed    --user-id <id> --amount <n>

Environment:
  INSTAGRAM_USERNAME   (optional, for password-based login fallback)
  INSTAGRAM_PASSWORD   (optional, for password-based login fallback)
  INSTAGRAM_TOTP_SECRET (optional, for 2FA)
  INSTAGRAM_SESSIONID  (optional, cookie-based login — preferred method)
  INSTAGRAM_CSRFTOKEN  (optional, cookie-based login — preferred method)
  INSTAGRAM_DS_USER_ID (optional, cookie-based login — preferred method)

Session persisted at ~/.openclaw/workspace/memory/minase/ig-session.json
All output is JSON on stdout; errors go to stderr.

Login strategy:
  1. If INSTAGRAM_SESSIONID is set, use cookie-based auth (bypasses UFAC challenge).
  2. Otherwise, fall back to instagrapi password-based login.
"""

import argparse
import json
import os
import socket
import sys
import time
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    Image = None

# Force IPv4: urllib3 tries IPv6 first which is extremely slow to Instagram's
# servers in some network environments, causing login timeouts.
_orig_getaddrinfo = socket.getaddrinfo
socket.getaddrinfo = lambda *args, **kwargs: [
    r for r in _orig_getaddrinfo(*args, **kwargs) if r[0] == socket.AF_INET
]

try:
    from instagrapi import Client
    from instagrapi.exceptions import (
        LoginRequired,
        ChallengeRequired,
        TwoFactorRequired,
        RateLimitError,
    )
except ImportError:
    print(
        json.dumps({"error": "instagrapi not installed. Run: pip install instagrapi pyotp"}),
        file=sys.stdout,
    )
    sys.exit(1)


SESSION_PATH = Path.home() / ".openclaw" / "workspace" / "memory" / "minase" / "ig-session.json"
MAX_RETRIES = 3
RETRY_BASE_DELAY = 5  # seconds


def _get_cookie_client() -> Client:
    """Authenticate via cookie-based login using INSTAGRAM_SESSIONID env var.

    This bypasses instagrapi's login flow entirely, which currently triggers
    an unresolvable UFAC challenge. Instead, we inject browser/app cookies
    directly and verify by calling a lightweight API.
    """
    import time as _time

    sessionid = os.environ.get("INSTAGRAM_SESSIONID")
    csrftoken = os.environ.get("INSTAGRAM_CSRFTOKEN")
    ds_user_id = os.environ.get("INSTAGRAM_DS_USER_ID")

    if not sessionid:
        return None

    mid_val = os.environ.get("INSTAGRAM_MID", "")
    ig_did = os.environ.get("INSTAGRAM_IG_DID", "")
    datr_val = os.environ.get("INSTAGRAM_DATR", "")
    rur_val = os.environ.get("INSTAGRAM_RUR", "")

    cl = Client()
    cl.delay_range = [1, 3]

    # Build minimal settings dict (avoids triggering instagrapi init with
    # missing device signatures that cause challenge_required on private API)
    device_id = ig_did or "cookie-bridge"
    settings = {
        "uuids": {
            "phone_id": device_id,
            "uuid": device_id,
            "client_session_id": device_id,
            "advertising_id": device_id,
        },
        "authorization_data": {
            "ds_user_id": ds_user_id or "",
            "sessionid": sessionid,
        },
        "last_login": _time.time(),
    }
    cl.set_settings(settings)

    # Inject cookies directly into the HTTP session.
    # Inject ALL available cookies — Instagram validates multiple cookie fields
    # for API operations (not just sessionid).
    cl.private.cookies.set("sessionid", sessionid, domain=".instagram.com")
    if csrftoken:
        cl.private.cookies.set("csrftoken", csrftoken, domain=".instagram.com")
    if ds_user_id:
        cl.private.cookies.set("ds_user_id", ds_user_id, domain=".instagram.com")
    if mid_val:
        cl.private.cookies.set("mid", mid_val, domain=".instagram.com")
    if ig_did:
        cl.private.cookies.set("ig_did", ig_did, domain=".instagram.com")
    if datr_val:
        cl.private.cookies.set("datr", datr_val, domain=".instagram.com")
    if rur_val:
        cl.private.cookies.set("rur", rur_val, domain=".instagram.com")
    # Inject extra static cookies that Instagram expects
    cl.private.cookies.set("ig_nrcb", "1", domain=".instagram.com")
    cl.private.cookies.set("ps_n", "1", domain=".instagram.com")
    cl.private.cookies.set("ps_l", "1", domain=".instagram.com")

    # Verify session is valid with a lightweight API call.
    # Use private.get() directly to avoid instagrapi's response parsing
    # which may fail on missing fields (e.g. pinned_channels_info).
    try:
        uid = int(ds_user_id) if ds_user_id else cl.user_id
        resp = cl.private.get(f"https://i.instagram.com/api/v1/users/{uid}/info/")
        data = resp.json()
        user = data.get("user", {})
        username = user.get("username", "?")
        followers = user.get("follower_count", 0)
        if not username:
            raise RuntimeError("Empty user data — session may be invalid")
        print(f"Cookie auth verified: @{username} (followers: {followers})", file=sys.stderr)

        # Persist session for reuse
        SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)
        cl.dump_settings(SESSION_PATH)
        SESSION_PATH.chmod(0o600)
        return cl
    except Exception as e:
        print(f"Cookie auth verification failed: {e}", file=sys.stderr)
        return None


def _get_password_client() -> Client:
    """Create and authenticate an instagrapi Client with session reuse via password."""
    username = os.environ.get("INSTAGRAM_USERNAME")
    password = os.environ.get("INSTAGRAM_PASSWORD")
    totp_secret = os.environ.get("INSTAGRAM_TOTP_SECRET")

    if not username or not password:
        raise RuntimeError("INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD must be set")

    cl = Client()
    cl.delay_range = [1, 3]

    # Try to restore session
    if SESSION_PATH.exists():
        try:
            cl.load_settings(SESSION_PATH)
            cl.login(username, password)
            # Verify session is valid (use lightweight endpoint)
            uid = cl.user_id
            cl.user_info(uid)
            return cl
        except (LoginRequired, ChallengeRequired, Exception):
            # Session expired, do fresh login
            print("Session expired, performing fresh login...", file=sys.stderr)

    # Fresh login
    if totp_secret:
        try:
            import pyotp
            totp = pyotp.TOTP(totp_secret)
            cl.login(username, password, verification_code=totp.now())
        except ImportError:
            raise RuntimeError("pyotp not installed but INSTAGRAM_TOTP_SECRET is set. Run: pip install pyotp")
    else:
        cl.login(username, password)

    # Persist session with restricted permissions
    SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)
    cl.dump_settings(SESSION_PATH)
    SESSION_PATH.chmod(0o600)
    return cl


def get_client() -> Client:
    """Create and authenticate an instagrapi Client.

    Login strategy (ordered by reliability for WRITE operations):
      1. Restore a saved password-based session (ig-session.json) — most reliable.
      2. Fresh password-based login — creates proper mobile API session.
      3. Cookie-based auth (INSTAGRAM_SESSIONID) — works for reads but
         often fails for writes (upload/configure) due to missing mobile
         device signatures.
    """
    # Strategy 1: Restore saved session (from a previous password login)
    if SESSION_PATH.exists():
        try:
            cl = Client()
            cl.delay_range = [1, 3]
            cl.load_settings(SESSION_PATH)
            # Re-login with credentials to refresh token if needed
            username = os.environ.get("INSTAGRAM_USERNAME")
            password = os.environ.get("INSTAGRAM_PASSWORD")
            if username and password:
                cl.login(username, password)
            else:
                # No credentials, just verify the session works
                uid = cl.user_id
                resp = cl.private.get(f"https://i.instagram.com/api/v1/users/{uid}/info/")
                if resp.status_code != 200:
                    raise RuntimeError("Saved session invalid")
            print(f"Restored saved session (user_id={cl.user_id})", file=sys.stderr)
            return cl
        except Exception as e:
            print(f"Saved session restore failed: {e}, trying fresh login...", file=sys.stderr)
            try:
                SESSION_PATH.unlink()
            except Exception:
                pass

    # Strategy 2: Fresh password-based login (creates proper mobile session)
    username = os.environ.get("INSTAGRAM_USERNAME")
    password = os.environ.get("INSTAGRAM_PASSWORD")
    if username and password:
        try:
            cl = _get_password_client()
            print(f"Password login successful (user_id={cl.user_id})", file=sys.stderr)
            return cl
        except Exception as e:
            print(f"Password login failed: {e}, trying cookie auth...", file=sys.stderr)

    # Strategy 3: Cookie-based auth (fallback — good for reads, unreliable for writes)
    cl = _get_cookie_client()
    if cl is not None:
        return cl

    raise RuntimeError(
        "All login strategies failed. Provide INSTAGRAM_USERNAME+PASSWORD "
        "or valid INSTAGRAM_SESSIONID."
    )


# Track whether we've already fallen back to password login during retry
_retry_used_password = False


def with_retry(fn):
    """Retry with exponential backoff on RateLimitError, re-login on LoginRequired.

    On LoginRequired, force a fresh password login (not cookie auth) since
    cookie-based sessions cannot perform write operations (upload/configure).
    """
    global _retry_used_password
    _retry_used_password = False
    last_error = None
    attempts_made = 0
    for attempt in range(MAX_RETRIES):
        attempts_made = attempt + 1
        try:
            return fn()
        except LoginRequired:
            print(f"LoginRequired on attempt {attempt + 1}, forcing password re-auth...", file=sys.stderr)
            # Force fresh password login by removing session AND
            # temporarily clearing SESSIONID so get_client() won't
            # use cookie auth again.
            if SESSION_PATH.exists():
                try:
                    SESSION_PATH.unlink()
                except Exception:
                    pass
            _retry_used_password = True
            last_error = "LoginRequired after re-auth"
        except RateLimitError:
            delay = RETRY_BASE_DELAY * (2 ** attempt)
            print(f"Rate limited, waiting {delay}s...", file=sys.stderr)
            time.sleep(delay)
            last_error = "RateLimitError"
        except Exception as e:
            last_error = f"{type(e).__name__}: {e}"
            break
    raise RuntimeError(f"Failed after {attempts_made} attempt(s): {last_error}")


def cmd_upload_photo(args):
    """Upload a local photo to Instagram."""
    image_path = Path(args.image)
    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    def do_upload():
        cl = get_client()
        media = cl.photo_upload(image_path, args.caption or "")
        return {
            "media_pk": str(media.pk),
            "media_code": media.code,
        }

    result = with_retry(do_upload)
    print(json.dumps(result))


def cmd_get_media_insights(args):
    """Get insights (likes, comments, reach, etc.) for a media by pk."""
    media_pk = int(args.media_pk)

    def do_insights():
        cl = get_client()
        try:
            insights = cl.insights_media(media_pk)
            return {
                "likes": insights.get("like_count", 0),
                "comments": insights.get("comment_count", 0),
                "reach": insights.get("reach_count", 0) or insights.get("reach", 0),
                "impressions": insights.get("impression_count", 0) or insights.get("impressions", 0),
                "saves": insights.get("save_count", 0),
            }
        except Exception:
            # Fallback to media_info if insights endpoint is unavailable
            media_info = cl.media_info(media_pk)
            return {
                "likes": media_info.like_count,
                "comments": media_info.comment_count,
                "reach": 0,
                "impressions": 0,
                "saves": 0,
            }

    result = with_retry(do_insights)
    print(json.dumps(result))


def cmd_get_media_info(args):
    """Get basic media info (like_count, comment_count)."""
    media_pk = int(args.media_pk)

    def do_info():
        cl = get_client()
        media = cl.media_info(media_pk)
        return {
            "pk": str(media.pk),
            "code": media.code,
            "like_count": media.like_count,
            "comment_count": media.comment_count,
            "caption_text": media.caption_text if media.caption_text else "",
            "taken_at": media.taken_at.isoformat() if media.taken_at else None,
        }

    result = with_retry(do_info)
    print(json.dumps(result))


def _format_hashtag_posts(name: str, medias):
    posts = []
    for m in medias:
        posts.append({
            "pk": str(m.pk),
            "code": m.code,
            "user_id": str(m.user.pk),
            "username": m.user.username,
            "like_count": m.like_count,
            "comment_count": m.comment_count,
            "caption_text": (m.caption_text or "")[:200],
            "thumbnail_url": str(m.thumbnail_url) if m.thumbnail_url else None,
            "taken_at": m.taken_at.isoformat() if m.taken_at else None,
        })
    return {"hashtag": name, "posts": posts}


def cmd_hashtag_top(args):
    """Get top media for a hashtag."""
    amount = int(args.amount) if args.amount else 15

    def do_hashtag():
        cl = get_client()
        medias = cl.hashtag_medias_top(args.name, amount=amount)
        return _format_hashtag_posts(args.name, medias)

    result = with_retry(do_hashtag)
    print(json.dumps(result))


def cmd_hashtag_recent(args):
    """Get recent media for a hashtag."""
    amount = int(args.amount) if args.amount else 15

    def do_hashtag():
        cl = get_client()
        medias = cl.hashtag_medias_recent(args.name, amount=amount)
        return _format_hashtag_posts(args.name, medias)

    result = with_retry(do_hashtag)
    print(json.dumps(result))


def cmd_get_user_info(args):
    """Get current user's profile info (follower count, etc.)."""
    def do_info():
        cl = get_client()
        try:
            info = cl.user_info(cl.user_id)
            return {
                "follower_count": info.follower_count,
                "following_count": info.following_count,
                "media_count": info.media_count,
                "username": info.username,
            }
        except (KeyError, TypeError) as e:
            # instagrapi model may not match current API response shape;
            # fallback to raw private API call
            import time as _time
            uid = cl.user_id
            resp = cl.private.get(f"https://i.instagram.com/api/v1/users/{uid}/info/")
            user = resp.json().get("user", {})
            return {
                "follower_count": user.get("follower_count", 0),
                "following_count": user.get("following_count", 0),
                "media_count": user.get("media_count", 0),
                "username": user.get("username", ""),
            }
    result = with_retry(do_info)
    print(json.dumps(result))


def cmd_get_comments(args):
    """Get comments for a media post."""
    media_pk = int(args.media_pk)
    amount = int(args.amount)

    def do_comments():
        cl = get_client()
        comments = cl.media_comments(media_pk, amount=amount)
        result = []
        for c in comments:
            result.append({
                "comment_pk": str(c.pk),
                "user_id": str(c.user.pk),
                "username": c.user.username,
                "text": c.text,
                "created_at": c.created_at_utc.isoformat() if c.created_at_utc else None,
                "like_count": c.like_count,
            })
        return result

    result = with_retry(do_comments)
    print(json.dumps(result))


def cmd_reply_comment(args):
    """Reply to a comment on a media post."""
    media_pk = int(args.media_pk)
    comment_pk = int(args.comment_pk)

    def do_reply():
        cl = get_client()
        time.sleep(30)  # throttle: min 30s between comment actions
        comment = cl.media_comment(media_pk, args.text, replied_to_comment_id=comment_pk)
        return {"success": True, "comment_pk": str(comment.pk)}

    result = with_retry(do_reply)
    print(json.dumps(result))


def cmd_post_comment(args):
    """Post a new comment on a media post."""
    media_pk = int(args.media_pk)

    def do_comment():
        cl = get_client()
        time.sleep(30)  # throttle: min 30s between comment actions
        comment = cl.media_comment(media_pk, args.text)
        return {"success": True, "comment_pk": str(comment.pk)}

    result = with_retry(do_comment)
    print(json.dumps(result))


def cmd_get_user_feed(args):
    """Get recent media posts for a user."""
    user_id = int(args.user_id)
    amount = int(args.amount)

    def do_feed():
        cl = get_client()
        medias = cl.user_medias(user_id, amount=amount)
        result = []
        for m in medias:
            result.append({
                "media_pk": str(m.pk),
                "caption": (m.caption_text or "")[:300],
                "like_count": m.like_count,
                "comment_count": m.comment_count,
                "taken_at": m.taken_at.isoformat() if m.taken_at else None,
            })
        return result

    result = with_retry(do_feed)
    print(json.dumps(result))


def _normalize_album_paths(image_paths):
    """Normalize album media list for instagrapi.

    instagrapi album_upload does not accept PNG directly (only jpg/jpeg/webp/mp4).
    We convert PNG files to temporary JPEGs to preserve current pipeline outputs.
    """
    normalized = []
    temp_files = []

    for raw in image_paths:
        p = Path(raw)
        suffix = p.suffix.lower()

        if suffix in (".jpg", ".jpeg", ".webp", ".mp4"):
            normalized.append(p)
            continue

        if suffix == ".png":
            if Image is None:
                raise RuntimeError("Pillow not installed; cannot convert PNG for album upload")
            if not p.exists():
                raise FileNotFoundError(f"Image not found: {p}")
            converted = p.with_suffix(".ig_album.jpg")
            with Image.open(p) as img:
                img.convert("RGB").save(converted, format="JPEG", quality=95)
            normalized.append(converted)
            temp_files.append(converted)
            continue

        raise RuntimeError(
            f"Unsupported album media format: {p.suffix}. Use jpg/jpeg/webp/mp4 or png (auto-converted)."
        )

    return normalized, temp_files


def cmd_upload_album(args):
    """Upload a carousel/album post.

    If configure_sidecar fails (500 error), falls back to uploading only
    the first image as a single photo. This prevents broken/corrupted posts
    from appearing on the user's profile.
    """
    image_paths = json.loads(args.images)

    # Single image: always use photo_upload (sidecar is unreliable for 1 image)
    if len(image_paths) == 1:
        p = Path(image_paths[0])
        if not p.exists():
            raise FileNotFoundError(f"Image not found: {p}")

        def do_single():
            cl = get_client()
            media = cl.photo_upload(p, args.caption or '')
            return {"media_pk": str(media.pk), "fallback": "single_photo"}

        result = with_retry(do_single)
        print(json.dumps(result))
        return

    normalized_paths, temp_files = _normalize_album_paths(image_paths)

    try:
        def do_album():
            cl = get_client()
            media = cl.album_upload(
                paths=normalized_paths,
                caption=args.caption or ''
            )
            return {"media_pk": str(media.pk)}

        try:
            result = with_retry(do_album)
            print(json.dumps(result))
        except RuntimeError as album_err:
            err_msg = str(album_err)
            if "500" in err_msg or "configure_sidecar" in err_msg:
                # configure_sidecar 500 — fallback to first photo only
                print(
                    f"Album upload failed ({err_msg}), falling back to single photo...",
                    file=sys.stderr,
                )
                def do_fallback():
                    cl = get_client()
                    media = cl.photo_upload(normalized_paths[0], args.caption or '')
                    return {"media_pk": str(media.pk), "fallback": "single_photo_after_album_500"}

                fallback_result = with_retry(do_fallback)
                print(json.dumps(fallback_result))
            else:
                raise
    finally:
        for temp in temp_files:
            try:
                if temp.exists():
                    temp.unlink()
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser(description="Instagram bridge via instagrapi")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # upload_photo
    p_upload = subparsers.add_parser("upload_photo")
    p_upload.add_argument("--image", required=True, help="Local image path")
    p_upload.add_argument("--caption", default="", help="Post caption")

    # get_media_insights
    p_insights = subparsers.add_parser("get_media_insights")
    p_insights.add_argument("--media-pk", required=True, help="Media PK (integer)")

    # get_media_info
    p_info = subparsers.add_parser("get_media_info")
    p_info.add_argument("--media-pk", required=True, help="Media PK (integer)")

    # hashtag_top
    p_hashtag = subparsers.add_parser("hashtag_top")
    p_hashtag.add_argument("--name", required=True, help="Hashtag name (without #)")
    p_hashtag.add_argument("--amount", default="15", help="Number of posts")

    # hashtag_recent
    p_hashtag_recent = subparsers.add_parser("hashtag_recent")
    p_hashtag_recent.add_argument("--name", required=True, help="Hashtag name (without #)")
    p_hashtag_recent.add_argument("--amount", default="15", help="Number of posts")

    # get_user_info
    subparsers.add_parser("get_user_info")

    # upload_album
    p_album = subparsers.add_parser("upload_album")
    p_album.add_argument("--images", required=True, help="JSON array of image paths")
    p_album.add_argument("--caption", default="", help="Post caption")

    # get_comments
    p_get_comments = subparsers.add_parser("get_comments")
    p_get_comments.add_argument("--media-pk", required=True)
    p_get_comments.add_argument("--amount", default="20")

    # reply_comment
    p_reply = subparsers.add_parser("reply_comment")
    p_reply.add_argument("--media-pk", required=True)
    p_reply.add_argument("--comment-pk", required=True)
    p_reply.add_argument("--text", required=True)

    # post_comment
    p_post_comment = subparsers.add_parser("post_comment")
    p_post_comment.add_argument("--media-pk", required=True)
    p_post_comment.add_argument("--text", required=True)

    # get_user_feed
    p_user_feed = subparsers.add_parser("get_user_feed")
    p_user_feed.add_argument("--user-id", required=True)
    p_user_feed.add_argument("--amount", default="5")

    args = parser.parse_args()

    try:
        if args.command == "upload_photo":
            cmd_upload_photo(args)
        elif args.command == "upload_album":
            cmd_upload_album(args)
        elif args.command == "get_media_insights":
            cmd_get_media_insights(args)
        elif args.command == "get_media_info":
            cmd_get_media_info(args)
        elif args.command == "hashtag_top":
            cmd_hashtag_top(args)
        elif args.command == "hashtag_recent":
            cmd_hashtag_recent(args)
        elif args.command == "get_user_info":
            cmd_get_user_info(args)
        elif args.command == "get_comments":
            cmd_get_comments(args)
        elif args.command == "reply_comment":
            cmd_reply_comment(args)
        elif args.command == "post_comment":
            cmd_post_comment(args)
        elif args.command == "get_user_feed":
            cmd_get_user_feed(args)
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stdout)
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
