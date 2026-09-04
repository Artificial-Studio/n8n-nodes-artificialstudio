# Changelog

## 1.0.0

Initial release.

- Generation → Run Tool with live tool and model pickers, per-model parameters loaded from the API, and media inputs from URLs or binary files.
- Three wait modes: poll until done, wait for webhook (no polling, execution resumes on callback), or return immediately.
- Download the generated file into a binary field.
- Generation → Get and Get Many (with Return All), Tool → Get and Get Many, File → Upload, Account → Get.
- Usable as an AI Agent tool.
- Readable errors for invalid keys, missing credits, unknown tools and rate limits, with retries on transient failures.
