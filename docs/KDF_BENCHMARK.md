# Argon2id benchmark

Measured 28 August 2026 on Windows x64 with Node v24.18.0. Target latency: at most 750 ms on this machine.

| Memory | Passes | Parallelism | Measured time |
| --- | ---: | ---: | ---: |
| 19 MiB | 2 | 1 | 63.6 ms |
| 32 MiB | 3 | 1 | 155.0 ms |
| 64 MiB | 3 | 1 | 324.0 ms |

Selected default: Argon2id v1.3, 64 MiB, three passes, parallelism one, 32-byte output.

These measurements are machine-specific. Run `npm.cmd run benchmark:kdf` on representative low-memory mobile, ordinary laptop, and desktop hardware before a public release. Hush accepts older v2 vaults at or above the documented 19 MiB/two-pass minimum and stores parameters with every vault.

