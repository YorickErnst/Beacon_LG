# Beacon for LG webOS (unofficial)

A TV app to browse, search and watch [Beacon](https://beacon.tv) (Critical Role) on LG webOS TVs, which have no
official Beacon app. Everything runs on the TV itself: no proxy server, no Docker, no extra hardware.

> **Unofficial.** Not made by, affiliated with or endorsed by Critical Role or Beacon. It talks to Beacon's
> private web API and signs in the way Beacon's own apps do, using beacon.tv's sign-in client. Beacon can change
> or block this at any time, and using it may be against Beacon's terms. Use it at your own risk, with your own
> Beacon account.

## Features

- **Home** with Beacon's member home page: featured banner, *Continue watching*, *Next episode*, and Beacon's own rows.
- **Series** and collections, with season tabs, episode progress bars, and a jump to the first unwatched episode.
- **Episode pages** with resume or start-over. They also suggest the next episode, other versions of the same
  episode (Cooldown, Abridged…), more from the series, and Beacon's recommendations.
- **Search** that forgives typos ("exandria unlimted"), finds partial words, series names and episode codes
  (`c4e12`, "campaign 4 episode 12"), with suggestions while you type.
- **Player** that uses the TV's own video player:
  - streams without DRM, so they play natively;
  - resume;
  - watch progress synced with beacon.tv (so *Continue watching* matches everywhere);
  - subtitles;
  - a countdown to the next episode.
- **Sign-in** with your Beacon email and password, using the TV's on-screen keyboard or a USB keyboard. The password
  is not stored, only sign-in tokens, which renew automatically. You stay signed in across reboots.
- Free videos work without signing in.
- Made for the remote: arrow keys, OK and Back. Interface in English.

## Requirements

- An LG TV with webOS, on which you can install your own apps: either a **rooted TV with
  [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel)**, or **Developer Mode**.
- Tested on an LG 50UP75006LF (webOS 6, 2021), rooted with Homebrew Channel. Developer Mode should work the same,
  but hasn't been tried. Older or newer webOS versions haven't been tested either.
- A Beacon account for member videos. If you normally sign in with an emailed link, set a password on beacon.tv first.
- If you use an ad blocker, Pi-hole or similar on your network: allow JW Player, which hosts Beacon's videos.
  The hosts are `jwplayer.com`, `jwpsrv.com` and `jwpcdn.com`, including `cdn.jwplayer.com`, `entitlements.jwplayer.com`,
  `prd.jwpltx.com` and `assets-jpcust.jwpsrv.com`. Otherwise playback stays black or fails.

## Install

The ready-made package is in [`dist/`](dist/): `org.home.beacon_1.1.1_all.ipk`.

### Option A: webOS Dev Manager (easiest)

1. Install [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop) on your computer.
2. Add your TV: a rooted TV, or Developer Mode with the passphrase from LG's Developer Mode app.
3. Open *Apps* → *Install*, choose `dist/org.home.beacon_1.1.1_all.ipk`.

### Option B: LG's command-line tools (Developer Mode or rooted)

```bash
npm install -g @webos-tools/cli
ares-setup-device            # add your TV (follow the prompts)
ares-install --device <your-tv-name> dist/org.home.beacon_1.1.1_all.ipk
```

### Option C: rooted TV over SSH or telnet

```bash
scp dist/org.home.beacon_1.1.1_all.ipk root@<tv-ip>:/tmp/beacon.ipk
ssh root@<tv-ip> 'luna-send -w 60000 -i luna://com.webos.appInstallService/dev/install "{\"id\":\"org.home.beacon\",\"ipkUrl\":\"/tmp/beacon.ipk\",\"subscribe\":true}"'
```

Wait for `"state":"installed"`, then press Ctrl+C.

After installing, *Beacon* appears in the TV's app list. On first start, sign in, or choose *Later (free videos
only)*. On a Developer Mode TV, apps stop working when the Developer Mode session expires. Renew it in LG's app,
or root the TV.

## Build from scratch

The app needs no compiler and no npm packages. Building only means packing `app/` and `service/` into an `.ipk`.

### With PowerShell (Windows, macOS, Linux)

Needs [PowerShell 7](https://learn.microsoft.com/powershell/scripting/install/installing-powershell) and `tar`.
`tar` is built into Windows 10 and later, macOS and Linux.

```bash
git clone https://github.com/YorickErnst/Beacon_LG.git
cd Beacon_LG
pwsh tools/make-ipk.ps1
```

This writes `dist/org.home.beacon_<version>_all.ipk`, taking the version from `app/appinfo.json`. It builds the
same layout as LG's `ares-package`:

| Path in the package | What |
|---|---|
| `usr/palm/applications/org.home.beacon/` | the web app |
| `usr/palm/services/org.home.beacon.service/` | the background service |
| `usr/palm/packages/org.home.beacon/packageinfo.json` | ties the app and the service together |

### With LG's webOS CLI

```bash
npm install -g @webos-tools/cli
ares-package app service -o dist
```

This produces an equivalent package. I haven't tested this route; the PowerShell script is what the published
`.ipk` is built with.

### Optional steps

- **Home page query:** if you update `tools/GetMemberHomePage.graphql` (the query beacon.tv uses for its member
  home page), regenerate `app/home-query.js` with `pwsh tools/make-home-query.ps1`.
- **Desk test:** try the app in a desktop browser without a TV. Run `python tools/desk-test.py` (Python 3), then
  open http://localhost:8799 in a 1920×1080 window. It serves `app/` and plays the part of the TV service. Sign-in,
  browsing, search and stream addresses all work. Video playback depends on your browser's HLS support. The desk
  test has no `playlist` method, so it always plays the stream as JW Player lists it.

## How it works

```
 TV
 ┌──────────────────────────────┐       luna://org.home.beacon.service
 │ app/  (web app, Chromium 79) │ ──────────────────────────────┐
 │  app.js      screens, keys,  │                               ▼
 │              player          │       ┌──────────────────────────────────────┐
 │  backend.js  sign-in, search │       │ service/ (JS service, TV's Node 8)   │
 │              index, Beacon   │       │  gql   → Beacon CMS (GraphQL)        │──► critrole-beacon-production-
 │              data per screen │       │  token → Memberful OAuth (sign-in)   │──► pocketbeacon.memberful.com
 └──────────────┬───────────────┘       │  text  → caption files (JW Player)   │──► *.jwplayer.com
                │                       │  playlist → stream list, best first, │──► cdn.jwplayer.com
                │                       │             served on 127.0.0.1      │
                │                       └──────────────────────────────────────┘
                └── <video> plays the HLS stream from JW Player (no DRM)
```

- **Why a service.** Beacon's GraphQL API only accepts `https://beacon.tv` as a browser origin, so the app's web
  view can't call it. The small service in the same package makes those HTTPS calls; everything else
  lives in the app.
- **Sign-in.** The service uses Memberful's password grant with beacon.tv's client ID, as Beacon's own TV apps do.
  The web sign-in form is behind a bot check. Tokens are kept in the app's `localStorage` (`beacon.auth`) and
  refreshed shortly before they expire. The password itself is never stored.
- **Search.** At first start the app builds an index of the whole catalogue, about 1,300 videos and 60 series,
  which takes a few seconds. It keeps the index in `localStorage` (`beacon.index`) and rebuilds it in the
  background every 6 hours. Search is fuzzy and works on the TV itself; Beacon's own search, which only matches
  whole words, is merged in.
- **Video.** Beacon is asked for streams without DRM (`x-supports-drm: false`). Those are plain HLS, which the
  TV's player handles natively. Progress is reported to Beacon the way beacon.tv reports it.
- **Full quality from the start.** JW Player's master playlist lists the 640×360 stream first, and the TV's player
  starts with the first stream it reads, so videos began blurry. Sorting alone doesn't fix it: about 4 s in, LG's
  player always drops to the lowest stream it is offered for a few seconds. So the service's `playlist` method
  fetches the master playlist and serves two copies on `127.0.0.1` for a few minutes: one with only the best
  stream, and one with all streams, best first. The app plays the best-only copy. If that stalls for 5 s (a slow
  connection), it switches to the full copy, where the player can step down. If a copy fails, or the service
  can't provide one, it plays the original playlist. The video data always comes straight from JW Player.
- **Older engines.** webOS 6 apps run on Chromium 79 and services on Node.js 8, so the code avoids newer syntax:
  no optional chaining or `??` in the app, and no `fetch` or object spread in the service.

### Project layout

| Path | What |
|---|---|
| `app/appinfo.json` | app ID `org.home.beacon`, version, icons |
| `app/index.html`, `app/app.css` | page and styles (1920×1080) |
| `app/app.js` | screens, focus navigation for the remote, sign-in form, player |
| `app/backend.js` | sign-in and tokens, Beacon queries, catalogue index and search, data for each screen |
| `app/home-query.js` | beacon.tv's home page query (generated) |
| `service/service.js` | the four service methods `gql`, `token`, `text` and `playlist` |
| `service/services.json`, `service/package.json` | service registration |
| `tools/` | build script, query generator, desk test |
| `dist/` | the built `.ipk` |

## Troubleshooting

- **Playback is black, or says "Playback failed".** Something on your network is blocking JW Player; see
  *Requirements*.
- **"Email address or password is incorrect".** Use *Show password* to check what the keyboard typed. Accounts
  without a password (sign-in by email link) need a password set on beacon.tv first.
- **"Beacon is not responding".** Check the TV's internet connection. If it keeps happening, Beacon may have
  changed its API.
- **The first search or Series page takes a few seconds.** The catalogue index is being built; after that it's
  instant.
