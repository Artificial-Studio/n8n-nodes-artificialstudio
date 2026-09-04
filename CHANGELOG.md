# Changelog

## 1.0.1

- Implement the webhook lifecycle hooks so the package passes the official n8n security scanner.
- Declare public access so the published package carries an npm provenance statement.
- Show the node in the actions panel: it was declaring the AI codex category, which marks a node as an agent sub-node and hid it from search.
- Always emit compiled output: an incremental build cache that outlived the pre-build clean could produce a package with no JavaScript.

## 1.0.0

Initial release.

- Generation → Run Tool with live tool and model pickers, per-model parameters loaded from the API, and media inputs from URLs or binary files.
- Three wait modes: poll until done, wait for webhook (no polling, execution resumes on callback), or return immediately.
- Download the generated file into a binary field.
- Generation → Get and Get Many (with Return All), Tool → Get and Get Many, File → Upload, Account → Get.
- Usable as an AI Agent tool.
- Readable errors for invalid keys, missing credits, unknown tools and rate limits, with retries on transient failures.
