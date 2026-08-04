# tests

Flat, one file per subject. Run with `npm test` from `packages/base`.

## The glob is deliberately not clever

```
node --import tsx --test tests/*.test.ts
```

Three patterns were tried before this one, and **two of them passed while running nothing**:

| pattern | what happened |
|---|---|
| `tests/**/*.test.ts` | `**` needs shell globstar, which `sh` does not enable. Expanded to nothing, ran 0 tests, exited 0. |
| `--test tests/` | Node walks the directory, but its default discovery matches `.js` only. Found nothing, exited 0. |
| `tests/*.test.ts tests/*/*.test.ts` | The second matched nothing, `sh` passed it through literally, node failed on a missing file. |

So: **keep tests flat in this folder.** A subdirectory will be skipped silently, which is
the worst outcome of the three. If nesting is ever genuinely needed, add the second glob at
the same time as the first subdirectory, never before.

After changing this script, check the run actually reports a test count. A green run with
`# tests 0` is the failure this note exists to prevent.
