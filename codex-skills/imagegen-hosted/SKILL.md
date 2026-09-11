---
name: imagegen-hosted
description: Generate raster images with the provider-hosted image_generation tool.
---

# Hosted image generation

Use the provider's hosted `image_generation` tool for raster-image requests. The
provider executes the image-generation operation server-side and returns the
completed image to Pi.

After generation, report the saved file path. The response may also include the
server's revised prompt and resolved image parameters; use those when reporting
what was generated.

For local edit/reference files or an explicitly requested output destination,
use the external `image_gen` proxy only when it is enabled in the extension
configuration. Do not create a CLI/API fallback.
