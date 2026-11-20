---
title: Hullpatch
---

# Hullpatch

Hullpatch repairs STL and 3MF files in the browser. It is part of
[townsville.cc](https://townsville.cc). Drop in a file and it closes holes, removes inside
walls, turns flipped faces outward and clears unprintable specks, so the file loads as a
clean, manifold solid in your slicer. The page never uploads anything: the repair runs in
a Web Worker in the tab.

## Two pieces

**The web page.** A static site. Files stay on your machine.

**The HTTP API.** An optional second service, built as its own image
(`ghcr.io/hibikipr/hullpatch-api`). It runs the same repair engine for scripts and
programs. Unlike the page, it receives your file and repairs it in memory on your own
server. You only get it if you deploy it, and the page never uses it.

## API documentation

- [API reference](api.md): authentication, endpoints, limits, configuration, errors,
  deployment and client examples (curl, Python, Node).
- [OpenAPI 3.1 spec](openapi.yaml): the same API as a machine-readable file.

## Links

- [Source on GitHub](https://github.com/hibikipr/hullpatch)
- [README](https://github.com/hibikipr/hullpatch#readme)
