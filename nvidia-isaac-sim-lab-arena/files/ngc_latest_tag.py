#!/usr/bin/env python3
"""Print the newest version tag of an NGC image, e.g. nvidia/isaac-sim -> 6.1.0.

Used by install-isaac.yml when isaac_sim_version / isaac_lab_version is "latest".
Only tags that look like a version count (6.1.0, 3.0.0-rc1); "latest" and other
names are ignored. Without --prerelease only releases count (6.1.0, not 6.2.0-rc1).
At an equal version number a release beats rc, rc beats beta, beta beats dev.

  NGC_API_KEY=... ngc_latest_tag.py nvidia/isaac-sim [--prerelease]
"""
import base64
import json
import os
import re
import sys
import urllib.parse
import urllib.request

REGISTRY = "https://nvcr.io"
VERSION = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-(dev|alpha|beta|rc)(\d*))?$")
RANK = {"dev": 0, "alpha": 1, "beta": 2, "rc": 3, None: 9}


def version_key(tag):
    m = VERSION.match(tag)
    if not m:
        return None
    major, minor, patch, pre, num = m.groups()
    return (int(major), int(minor), int(patch), RANK[pre], int(num or 0))


def newest(tags, prerelease=False):
    keyed = [(version_key(t), t) for t in tags]
    keyed = [(k, t) for k, t in keyed if k is not None and (prerelease or k[3] == RANK[None])]
    if not keyed:
        return None
    return max(keyed)[1]


def _get(url, headers):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
        return r.read(), r.headers.get("Link", "")


def list_tags(repo, api_key):
    scope = urllib.parse.quote(f"repository:{repo}:pull")
    auth = {}
    if api_key:
        basic = base64.b64encode(f"$oauthtoken:{api_key}".encode()).decode()
        auth = {"Authorization": f"Basic {basic}"}
    body, _ = _get(f"{REGISTRY}/proxy_auth?account=%24oauthtoken&scope={scope}", auth)
    token = json.loads(body)["token"]
    headers = {"Authorization": f"Bearer {token}"}
    tags, url = [], f"{REGISTRY}/v2/{repo}/tags/list?n=1000"
    while url:
        body, link = _get(url, headers)
        tags += json.loads(body).get("tags") or []
        m = re.search(r"<([^>]+)>;\s*rel=\"next\"", link)
        url = urllib.parse.urljoin(REGISTRY, m.group(1)) if m else None
    return tags


def main(argv):
    if not argv or argv[0].startswith("-"):
        sys.exit(__doc__)
    tag = newest(list_tags(argv[0], os.environ.get("NGC_API_KEY", "")), "--prerelease" in argv)
    if tag is None:
        sys.exit(f"no version tag found for {argv[0]}")
    print(tag)


if __name__ == "__main__":
    main(sys.argv[1:])
