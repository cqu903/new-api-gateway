# ADR-0001：分页计算用纯函数 clampPagination，不引入泛型 Paginate[T]

- 状态：Accepted
- 日期：2026-07-24
- 关联：`CONTEXT.md` → Pagination

## 背景（Context）

trace 列表与 anomaly 列表各自实现了分页：count 查询、`totalPages` 计算、page 钳到末页、`Pagination` 组装（`HasPrev`/`HasNext`）。其中只有「`totalPages` 计算 + clamp + nav flags」是两处**逐字相同**的纯逻辑（约 18 行）；count 与 list 的 SQL 差异是**真实**的——不同表（`traces t` vs `usage_anomalies`）、不同 where 来源、不同 scan 目标（traces 委托 `listTraceRows`，anomalies 内联 scan 到带 `pgtype.FlatArray` 的 `AnomalySummary`）。

考虑过用 Go 泛型 `Paginate[T](ctx, countSQL, countArgs, listSQL, listArgs, page, limit, scan)` 把 count+list+clamp+组装全部藏到一个接口背后。

## 决策（Decision）

不引入泛型。新增纯函数 `clampPagination(page, limit, totalItems) (page, Pagination)`，只收 normalize + clamp + flags；count 查询、list 查询、where 构造、scan 各自留在 `ListTraces` / `ListAnomalies`。

## 理由

- **接口与行为量匹配**：真正逐字重复的只有约 18 行纯逻辑。泛型为藏这 18 行，必须把 `countSQL`、`listSQL`、`scan` 回调摆上接口（≈8 个参数），接口比它所藏的实现还啰嗦——这是「接口几乎和实现一样复杂」的浅模块。
- **count/list 的差异属于各自领域**：表名、scan 结构是 trace 与 anomaly 各自的领域细节，留在各自的 list 方法里是正确的局部性；把它们拽进通用泛型反而造成泄漏。
- **删除测试通过**：删掉 `clampPagination`，clamp + flags 公式会重现于两个调用点；它确实在赚回自己的存在。

## 后果（Consequences）

- 正：`ListTraces`/`ListAnomalies` 各减约 18 行重复；新 list 视图白拿分页计算；clamp 行为有独立测试面（接口即测试面）。
- 负：count 查询模板（`SELECT count(*) FROM <table> WHERE …`）仍各写一份——但表名/where 本就各不同，这不属于可消除的重复。
- **重开信号**：若未来出现第三、第四个分页列表，且它们的 count/list 形状趋于一致，可重新评估泛型；届时「两个以上的真实调用点形状趋同」才是重开本决策的依据。
