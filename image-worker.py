"""Validate QQ images and produce bounded, metadata-free previews for vision."""
import json
import sys
import warnings
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 20_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)

try:
    source, preview = sys.argv[1:3]
    with Image.open(source) as im:
        fmt = im.format
        if fmt not in {'PNG', 'JPEG', 'GIF', 'WEBP'}:
            raise ValueError('unsupported format')
        if im.width * im.height > 20_000_000 or max(im.size) > 10000:
            raise ValueError('oversized dimensions')
        width, height = im.size
        animated = bool(getattr(im, 'is_animated', False))
        if getattr(im, 'n_frames', 1) > 300:
            raise ValueError('too many frames')
        im.verify()
    with Image.open(source) as im:
        im.seek(0)
        frame = ImageOps.exif_transpose(im).convert('RGBA')
        frame.thumbnail((1280, 1280))
        background = Image.new('RGB', frame.size, 'white')
        background.paste(frame, mask=frame.getchannel('A'))
        background.save(preview, 'JPEG', quality=88, optimize=True)
    print(json.dumps({'format': fmt, 'extension': {'JPEG': 'jpg', 'PNG': 'png', 'GIF': 'gif', 'WEBP': 'webp'}[fmt],
                      'width': width, 'height': height, 'animated': animated}))
except Exception:
    print('IMAGE_VALIDATION_FAILED', file=sys.stderr)
    sys.exit(1)
