# Реестр миграционного паритета

Реестр issue #3 фиксирует, куда должна перейти каждая проверяемая гарантия исходного процесса. Он не является runtime-ledger, roadmap или доказательством готовой реализации.

## Состояние покрытия

- Mapping coverage: 100% (37/37)
- Implemented parity: 0% (0/37)
- Verified parity: 0% (0/37)
- `v1`: 31 запись
- `post_v1`: 6 записей

Диспозиции:

| Диспозиция | Количество |
| --- | ---: |
| `ported` | 0 |
| `adapted` | 30 |
| `superseded` | 1 |
| `intentionally_deferred` | 6 |
| `rejected` | 0 |

Aggregate digest: `1bffce04f2dbde44c1cfe0dc4eefe29ed6a51afade1869f7a5d4d90333901501`.

Digest считается от domain separator `autosk-flow.traycer-parity.v1`, затем от полного упорядоченного JSON-представления всех полей 37 записей. Поле digest не входит в собственный preimage. Full candidate tree дополнительно связывает registry, schema, validator, tests и документацию.

## Состав

| Вид источника | Количество | Статус |
| --- | ---: | --- |
| Agent Selection Guide | 1 | сопоставлен |
| Protocol files | 12 | сопоставлены |
| Traycer skills | 13 | сопоставлены |
| Source executable | 1 | заменяется autosk-native helpers |
| Command capabilities | 6 | сопоставлены |
| Test suites | 2 | сопоставлены |
| Validation records | 2 | сопоставлены |

Все target versions имеют значение `unreleased`, а verification status — `planned`. Поэтому полнота сопоставления не может быть прочитана как полнота реализации.

У 31 file-backed записи `hashKind` равен `source_bytes`: эти значения перепроверяются по локальным regular files в migration-only режиме. У шести command capabilities `hashKind` равен `derived_capability`: их identity детерминированно связывает command ID с SHA-256 исходного executable, но не притворяется отдельным source-byte hash.

## Отложенные возможности

`post_v1` содержит шесть записей:

- Autobuild run contract;
- Autobuild workflow;
- Reflect reviewer contract;
- Debate workflow;
- Housekeeping workflow;
- Changeset Walkthrough workflow.

У каждой записи есть причина, риск, владелец, trigger возврата и явное доказательство отсутствия implementation claim. Они остаются частью полной программы, но не активны в v1.

Тексты `autobuild/run-contract.md` и `reflect/reviewer-brief.md` всё равно входят в exact 12-file v1 governance bundle как неактивные protocol bytes. Отложена активация соответствующих workflows, а не поставка полного проверяемого bundle.

## Source evidence

Архивы представлены только очищенными logical locators, SHA-256 и наблюдёнными числами. Bytes архивов в репозиторий не входят.

| Evidence ID | SHA-256 | Inventory |
| --- | --- | --- |
| `archive.agents` | `18e9f6b0f874c5459482137e34aaac2d0a2230a43de620e959def23d1e246dc8` | 102 entries, 0 symlinks; незафиксированные разрезы не выдумываются |
| `archive.protocol` | `d8a7907e0de5a7e2ae0019d3e901144a22538159c446b3a02c59d531dd84bcbd` | 40 entries, 33 files, 7 directories, 0 symlinks |
| `archive.skills` | `5dde22dc3dcd942b8cb8fa960900bd4f7d66857155514ac364e410fb557d67e1` | 102 entries, 85 files, 17 directories, 0 symlinks |
| `archive.traycer-rules` | `b5fff796c0f47f76b9c7bc8592254eb7c1f83f27a356837058a6d38cc8fb0bfd` | 2924 entries, 2750 files, 174 directories, 0 symlinks |

Два requested archive остаются `not_found`: `gap.bin-2-archive` и `gap.protocol-3-archive`. Они не блокируют mapping, потому что executable, tests, двенадцать protocol files и альтернативный protocol archive идентифицированы отдельно. Gap не считается закрытым.

## Проверка

Обычная публичная проверка не читает локальные миграционные источники:

```text
npm test
npm run validate:migration
node scripts/validate-traycer-parity.mjs resources/traycer-parity/registry.v1.json
```

Migration-only проверка получает ignored local source map, перечитывает 31 regular file и сравнивает реальные bytes с registry hashes. По умолчанию она ничего не записывает:

```text
node scripts/validate-traycer-parity.mjs --verify-sources .autosk-evidence/autobuild/issue-3/source-map.local.json
```

Опциональный report разрешён только по явно переданному пути вне worktree. CI не требует приватных источников и проверяет registry, схему, документацию, отрицательные случаи и точный changed-file scope.

Exact eight-file scope проверяется только пока registry отсутствует в base ref текущего PR. После интеграции issue #3 будущие PR пропускают этот одноразовый scope gate, но продолжают обычные registry tests. Защитой workflow path, required checks и branch policy владеет delivery-profile issue #17.
