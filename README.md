# n8n-nodes-artificialstudio

Run [Artificial Studio](https://artificialstudio.ai) from your n8n workflows: generate images, video, audio and 3D with 150+ AI models, upload files from previous nodes, download results as binary, and let AI Agents call it as a tool.

[Installation](#installation) · [Credentials](#credentials) · [Operations](#operations) · [Examples](#examples) · [Development](#development)

## Installation

**n8n Cloud and self-hosted (recommended)**: open the nodes panel, search for "Artificial Studio" and install it from there. If it does not show up yet, go to **Settings → Community Nodes → Install** and enter `n8n-nodes-artificialstudio`.

**Manual install on a self-hosted instance**:

```bash
cd ~/.n8n/nodes
npm install n8n-nodes-artificialstudio
# restart n8n
```

Requires n8n 1.80 or later.

## Credentials

1. In Artificial Studio open **Settings → API Keys** and create a key. It starts with `prod_`.
2. In n8n go to **Credentials → New → Artificial Studio API** and paste it.

Credits are charged from your Artificial Studio account at the same rates as the web app. The cost of every model is shown next to its name in the node.

## Operations

### Generation → Run Tool

The main operation. Pick a **Tool** (Create Image, Create Video, Upscale, Remove Background, Text to 3D…), optionally a **Model**, write a **Prompt**, and set:

- **Media Inputs**: the images, videos or audio the tool works on. Each entry maps a file to one of the model's inputs. The source can be a public **URL** or a **Binary File** coming from a previous node (Gmail, Drive, Telegram, HTTP Request…). Binary files are uploaded to your library first.
- **Parameters**: the model's own settings (aspect ratio, duration, resolution, seed…) loaded live from the API with their defaults. Anything left empty uses the model default.
- **Wait For Result**:
  - **Poll Until Done** (default): checks the status every few seconds until the generation finishes, up to **Timeout**.
  - **Wait For Webhook**: pauses the execution without polling and resumes when Artificial Studio calls back. No timeout, no wasted executions. Needs an n8n URL reachable from the internet (n8n Cloud, or `WEBHOOK_URL` set on self-hosted) and one item per execution.
  - **Return Immediately**: returns the generation ID right away. Fetch the result later with **Generation → Get**, or set **Options → Webhook URL** to be notified.
- **Options → Download Output**: writes the generated file into a binary field so the next node (Drive, Slack, Telegram, S3…) can use it directly.

Output fields: `id`, `status`, `tool`, `type`, `output` (URL), `thumbnail`, `payload`, `createdAt`.

### Generation → Get / Get Many

Fetch one generation by ID, or list yours with **Return All** or a **Limit**, filtered by status. **Get** also supports **Download Output**.

### File → Upload

Upload a binary file and get its public URL. Useful when you want to reuse the same file in several generations.

### Tool → Get / Get Many

List the tools, or inspect one with its models, costs and input fields. Handy while building a workflow.

### Account → Get

Email, plan and remaining credits. Chain it with an **IF** node to stop a workflow before running out of credits.

## Use as an AI Agent tool

The node is marked as usable by AI Agents. Add it to an **AI Agent** node's tools and the agent can generate media on demand, for example "make a 16:9 product shot of a red sneaker on concrete". On self-hosted instances older than 1.80 set `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`.

## Examples

Import the JSON files in [`workflows/`](./workflows) to get started:

- **Prompt form to image**: an n8n Form collects a prompt, the node generates the image and downloads it, and the form responds with the file.
- **Telegram background remover**: a Telegram bot receives a photo, the node removes its background from the binary file, and the bot sends the result back.

## Errors

The node surfaces Artificial Studio errors with a readable message: invalid API key, not enough credits, unknown tool or model, rate limits. Transient failures (network errors, 429, 5xx) are retried with backoff while polling. Enable **Retry On Fail** in the node settings for anything else.

## Development

```bash
npm install
npm run dev      # starts n8n with the node linked and hot reload
npm run lint
npm run build
npm test
```

Releases are published from GitHub Actions with npm provenance (see `.github/workflows/publish.yml`). Run `npm run release` on a clean `main` to lint, build, bump the version, update the changelog, tag and push.

## Resources

- [Artificial Studio API docs](https://docs.artificialstudio.ai)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)

## License

[MIT](LICENSE)
