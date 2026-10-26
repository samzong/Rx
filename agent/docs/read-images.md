# Local image reads

The `read` tool identifies PNG, JPEG, GIF, and WebP files from their byte signatures.
The file extension does not determine the returned media type.
The tool returns the absolute source path as text and the original file bytes as a base64 image block.
Text pagination does not apply to images.
Text line numbers, pagination, truncation, and non-image binary errors keep their existing behavior.

The current model must declare image input when the tool executes.
An unsupported model receives a tool error that asks for a model with image support and another read.
Model changes between ACP prompts therefore change image-read capability without rebuilding tools.
The file limit is 3 MiB, which produces at most 4 MiB of base64 data.
The reader checks the file size before allocating image data and reads at most that size plus one byte.
An oversized image receives an error that asks for a smaller or cropped copy.
Neither side can exceed 8000 pixels, the single-image dimension limit documented by the [Claude API](https://platform.claude.com/docs/en/build-with-claude/vision#request-limits).
Rx reads dimensions from PNG IHDR, GIF screen descriptors, WebP VP8/VP8L/VP8X headers, and JPEG SOFn segments.
An unparseable or zero dimension produces a malformed-header error that asks for a newly exported copy.
A dimension error gives the actual width and height, the limit, and a resize command example.
On macOS, use `sips -Z 2000 <path> --out <copy>`, then read the copy.
Rx does not resize images or decode their pixels. Provider-specific encoding and cumulative request limits still apply.

A rejected image in stored tool results can make every later model request fail.
The 8000-pixel check prevents that single-image dimension failure before the image enters history.
It does not prevent cumulative image-count, byte, or conditional dimension limits across a request.
For example, the Claude API applies a stricter dimension limit when a request contains more than 20 images.
If a cumulative limit blocks a session, a text-only model avoids the failure only while that model is selected.
Switching back to an image-capable model sends the stored images again.
Start a new session for reliable recovery.
Compaction retains recent images, so `/compact` alone does not reliably recover a blocked session.

The existing tool-result path carries the image to pi-agent-core, the session log, and ACP tool cards.
ACP load replays the complete original result. The session log keeps its v1 format.
Compaction keeps recent images and omits older images from the summary transcript under RX-COMPACT-003.
A later `read` retrieves the image again if the source file still exists.
The launcher retains RX-AGENT-001..003 and its environment-only handoff.

The strongest alternative is pi-coding-agent 1.4.0 `createReadTool` with automatic resizing.
That tool also changes text output and binary handling. Its Photon decoder needs an external WASM file in compiled installations.
Rx retains its text path and bounded original images to preserve screenshot detail without expanding the installation layout.
Revisit automatic resizing if normal screenshots repeatedly exceed 3 MiB or a required provider rejects their dimensions.

For Lody acceptance, install with `make install` and start an Rx session with an image-capable model.
Ask the model to read a local PNG screenshot and describe its text and layout.
The read tool card must contain an image, and the description must match the screenshot.
Load the session again and make sure that the image result remains available.
After `/compact`, ask for another read of the same source. The new result must contain the image again.
With a text-only model, an image read must return the model-selection error.
An image with either side over 8000 pixels must return a failed tool call with resize instructions and no image block.
A non-image binary file must still return a binary-file error.
