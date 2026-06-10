# Archived branches

Before opening this repository publicly, stale remote branches were removed from GitHub. Each branch tip was preserved as an annotated tag under `archive/*`.

To inspect an archived branch:

```bash
git fetch --tags
git log -1 archive/repo-split
git checkout archive/repo-split   # detached HEAD at that branch tip
```

| Tag | Former branch | Notes |
|-----|---------------|-------|
| `archive/repo-split` | `repo-split` | Public repo split (operator tooling moved to kash-ops) |
| `archive/batchops-rewrite` | `batchops-rewrite` | Batch ops rewrite work |
| `archive/KashYieldBtc` | `KashYieldBtc` | Early BTC product branch |
| `archive/kashyieldeth` | `kashyieldeth` | ETH product development |
| `archive/landing-page` | `landing-page` | Landing page work |
| `archive/feature/dual-nav-update-pre-and-post-ops` | `feature/dual-nav-update-pre-and-post-ops` | Dual NAV update feature |
| `archive/Nova-update` | `Nova-update` | Early project history (not merged to `main`) |
| `archive/tests` | `tests` | Test/docs branch (2 commits not in `main`) |

Active development continues on **`main`**.
