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
  get_comments     --media-pk <pk> --amount <n>
  reply_comment    --media-pk <pk> --comment-pk <pk> --text <text>
  post_comment     --media-pk <pk> --text <text>
  get_user_feed    --user-id <id> --amount <n>

Environment:
  INSTAGRAM_USERNAME   (required)
  INSTAGRAM_PASSWORD   (required)
  INSTAGRAM_TOTP_SECRET (optional, for 2FA)

Session persisted at ~/.openclaw/workspace/memory/minase/ig-session.json
All output is JSON on stdout; errors go to stderr.
"""

import argparse
import json
import os
import socket
import sys
import time
from pathlib import Path

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


def get_client() -> Client:
    """Create and authenticate an instagrapi Client with session reuse."""
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
            # Verify session is valid
            cl.get_timeline_feed()
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


def with_retry(fn):
    """Retry with exponential backoff on RateLimitError, re-login on LoginRequired."""
    last_error = None
    for attempt in range(MAX_RETRIES):
        try:
            return fn()
        except LoginRequired:
            print(f"LoginRequired on attempt {attempt + 1}, re-authenticating...", file=sys.stderr)
            # Force fresh login by removing session
            if SESSION_PATH.exists():
                SESSION_PATH.unlink()
            # Retry will trigger fresh login via get_client()
            last_error = "LoginRequired after re-auth"
        except RateLimitError:
            delay = RETRY_BASE_DELAY * (2 ** attempt)
            print(f"Rate limited, waiting {delay}s...", file=sys.stderr)
            time.sleep(delay)
            last_error = "RateLimitError"
        except Exception as e:
            last_error = str(e)
            break
    raise RuntimeError(f"Failed after {MAX_RETRIES} retries: {last_error}")


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


def cmd_hashtag_top(args):
    """Get top media for a hashtag."""
    amount = int(args.amount) if args.amount else 15

    def do_hashtag():
        cl = get_client()
        medias = cl.hashtag_medias_top(args.name, amount=amount)
        posts = []
        for m in medias:
            posts.append({
                "pk": str(m.pk),
                "code": m.code,
                "like_count": m.like_count,
                "comment_count": m.comment_count,
                "caption_text": (m.caption_text or "")[:200],
                "thumbnail_url": str(m.thumbnail_url) if m.thumbnail_url else None,
            })
        return {"hashtag": args.name, "posts": posts}

    result = with_retry(do_hashtag)
    print(json.dumps(result))


def cmd_get_user_info(args):
    """Get current user's profile info (follower count, etc.)."""
    cl = get_client()
    def do_info():
        info = cl.user_info(cl.user_id)
        return {
            "follower_count": info.follower_count,
            "following_count": info.following_count,
            "media_count": info.media_count,
            "username": info.username,
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


def cmd_upload_album(args):
    """Upload a carousel/album post."""
    cl = get_client()
    image_paths = json.loads(args.images)
    media = with_retry(lambda: cl.album_upload(
        paths=[Path(p) for p in image_paths],
        caption=args.caption or ''
    ))
    print(json.dumps({"media_pk": str(media.pk)}))


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
