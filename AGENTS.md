# Pebble preview and release instructions

- Watch app preview UUID is `4891b943-0458-47da-a124-ca74147622d5`.
- Plugin preview UUID is `db70a3a2-21d7-4ca2-9ea4-d0b38848431a`.
- This repository uses the plugin preview UUID and `Home Assistant Bridge Test` as its preview name. Apply both values in a temporary build manifest. Restore the tracked `package.json` after building. Keep this preview UUID stable across test builds.
- Each UUID is a shared slot. Remove the installed test copy before switching to a preview of a different product. A test of a plugin through a watch app requires the test client to reference the matching plugin preview UUID.
- For a production release, fetch `origin/main` and read the current `package.json`. Use the production UUID and display name from `main`. Increment the minor version in `main` by one, reset the patch to zero, and synchronize the top-level version and `pebble.version` where both are present. For example, `2.4.4` becomes `2.5.0`.
- Run regression tests before building. Verify the packaged UUID and version in `appinfo.json` and provide a direct PBW download.
