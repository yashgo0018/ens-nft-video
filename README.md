# ENS commemorative NFT video

Download the animation of an ENSv2 commemorative NFT
([`0x20262e3433306a4ff250a64d20a8e0f09b2c7f68`](https://etherscan.io/address/0x20262e3433306a4ff250a64d20a8e0f09b2c7f68))
as an MP4, from its OpenSea URL or token ID.

The NFT's `animation_url` is a live WebGL page, not a video file. Both tools use
the artwork's built-in capture mode (`window.ens.time.stepCapture(frame)`) to
render its 600-frame loop (10 s at 60 fps) one frame at a time, so the result
loops seamlessly with no dropped frames.

## Web app

Live at **https://ens-nft-video.vercel.app**. Prefill with
`?url=<opensea-url>` or `?tokenId=<id>`.

Everything runs in the visitor's browser: [`web/vercel.json`](web/vercel.json)
proxies `v2.nft.ens.domains` under `/art/` so the artwork iframe is same-origin,
then [`web/index.html`](web/index.html) steps each frame and encodes it with
WebCodecs and [mp4-muxer](https://github.com/Vanilagy/mp4-muxer). Needs a
browser with WebCodecs `VideoEncoder`.

Deploy:

```bash
cd web && vercel deploy --prod
```

## CLI

Drives headless Chrome over the DevTools protocol and pipes frames to ffmpeg.
No npm dependencies; needs Node 22+, Google Chrome (or `CHROME_PATH`) and ffmpeg.

```bash
node download.mjs "https://opensea.io/item/ethereum/0x20262e3433306a4ff250a64d20a8e0f09b2c7f68/<tokenId>"
```

| Option | Default | |
| --- | --- | --- |
| `-o, --out <file>` | `<name>.mp4` | Output path |
| `--loops <n>` | `1` | Repeat the 10 s loop n times |
| `--scale <1\|2>` | `1` | 1080×1400 or 2160×2800 |
| `--transparent` | off | Transparent background, VP9 WebM |

`ETH_RPC_URL` overrides the RPC used to read `tokenURI`
(default `https://ethereum-rpc.publicnode.com`).
