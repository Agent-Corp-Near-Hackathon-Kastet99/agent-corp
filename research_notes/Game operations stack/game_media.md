# Game media production

## Can Claude itself record/edit gameplay?

### Takeaway
Claude can drive a computer/browser only when an application supplies and executes its computer-use or browser-use tools. It does not itself create a finished gameplay-video file, so pair it with deterministic browser recording and a renderer/editor.

### Cited Findings
- Anthropic's computer-use toolset provides screenshots plus mouse and keyboard actions, but each tool call is executed by the client application in an environment it controls. [Claude computer use docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- Anthropic recommends narrower browser tools for web-only work; computer use is general but slower because it normally needs fresh screenshots after action batches. [Claude tool combinations docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-combinations)
- Playwright can record a browser context with `recordVideo`; the video is saved only after the context closes, and the saved path can be obtained or copied with `page.video()`. [Playwright video docs](https://playwright.dev/docs/videos) [Playwright Video API](https://playwright.dev/docs/api/class-video)
- Current workspace manifests do not list Playwright, Remotion, or an editing service dependency. [workspace manifest](/Users/kastet/Agent%20Corp/package.json)

### Inferences
- Use Claude for script, captions, and a deterministic input plan — for example: move, wait for TV watcher, drop flowerpot, collect two RAM sticks, exit. Use Playwright to replay this plan, rather than asking an agent to improvise a demo run.
- Human must approve any publish, spend, or account-connected action. Claude computer-use guidance explicitly calls for confirmation around meaningful real-world consequences. [Claude computer use docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)

### Gaps
- No installed Claude/Anthropic MCP in this workspace was identified by package manifests. Account credentials and any existing app connections were not inspected.

## Which action-capable stack fits tiny web-game demo?

### Takeaway
Lowest-risk stack: Playwright records deterministic browser gameplay; FFmpeg makes one fast cut/caption pass; store final MP4 beside deploy artifacts. Add Remotion only if branded titles, animated ledger overlays, or repeatable social variants justify a React video composition.

### Cited Findings
- Playwright video capture is available both in Playwright Test configuration and manually created browser contexts; video dimensions can be set, and default capture is scaled to fit 800×800. [Playwright video docs](https://playwright.dev/docs/videos)
- Remotion supports CLI rendering (`npx remotion render`) and a server-side rendering API. [Remotion render docs](https://www.remotion.dev/docs/render)
- Remotion's `renderMedia()` programmatically renders audio/video and supports an output location or in-memory buffer. [Remotion renderer docs](https://www.remotion.dev/docs/renderer/render-media)
- Remotion client-side rendering needs WebCodecs and currently documents Chrome 94+, Firefox 130+, and Safari 26+ as minimum browser versions. [Remotion client-side rendering docs](https://www.remotion.dev/docs/client-side-rendering/)
- Remotion says assets added after bundle are unavailable to normal bundled renders; server-side APIs can add assets after bundling. [Remotion asset docs](https://www.remotiondocs.com/docs/assets)

### Inferences
- For hackathon demo, do not start with cloud video SaaS or an autonomous GUI editor. One recorded 20–30 second clip, a manually approved caption script, and one local FFmpeg/Remotion render is more repeatable.
- Add `@playwright/test` only for scripted recording. Add Remotion only when exact template-driven social clips are needed; otherwise FFmpeg is smaller operational surface.
- Record at fixed browser viewport matching target social format. Close browser context before copying/uploading capture, because Playwright only guarantees finished video after close. [Playwright video docs](https://playwright.dev/docs/videos)

### Gaps
- No official API source was found in this pass for an AI editor that reliably accepts a gameplay video, performs requested edits, and returns a production-ready clip. Do not promise automated AI editing until a vendor/API and account are selected.
- Rendering cost, codec availability, and deployment storage limits depend on host. They need a one-clip rehearsal.

## What demo workflow has lowest setup/risk?

### Takeaway
Create one approved gameplay path, replay it in browser, capture it, generate copy/caption timing with Claude, render it deterministically, then let a human approve the final clip before any post.

### Cited Findings
- Playwright can retain or discard capture artifacts by test outcome and exposes video configuration including mode and size. [Playwright TestOptions docs](https://playwright.dev/docs/api/class-testoptions)
- Remotion offers server-side, CLI, GitHub Actions, and Lambda render routes; its CLI supports width, height, FPS, duration, and serialized input props. [Remotion render docs](https://www.remotion.dev/docs/render) [Remotion CLI docs](https://convert.remotion.dev/docs/cli/render)
- Claude browser use supports page-aware actions and screenshots, including form input and file input, but tool execution still belongs to the application. [Claude browser-use docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool)

### Inferences
- Recommended runbook: (1) seed House 01; (2) Playwright executes approved route; (3) capture 16:9 master; (4) Claude drafts 3–5 captions and post copy from the completed run; (5) FFmpeg/Remotion makes master plus vertical crop; (6) human watches output; (7) approved publisher tool posts it.
- Keep raw capture, final render, caption script, and post URL as immutable campaign artifacts. This makes dashboard activity evidence-based rather than “agent says it posted.”
- Use the clip to show work performed by contributors, not as proof that a purchase immediately paid them. The period-close dashboard remains separate.

### Gaps
- Actual social publisher, storage host, and account permissions are outside this media scope and need separate research.
