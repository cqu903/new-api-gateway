---
name: cut-release
description: 为本仓库切版本发布——分析上一个 tag 到当前代码的变动，按需推送 main、创建并推送新的 semver tag、在 GitHub 上发布带「面向用户、功能导向、非技术化」中文 release notes 的 release。只要用户想发布/发版/切版本/打个 tag/建 release/总结两个 tag 之间的改动，就必须用这个 skill，即使用户只说「打个 tag」「发个版本」「release 一下」「publish a release」「cut a release」「tag and release」也要触发。
---

# Cut a Release（打 tag + 发 GitHub release）

本仓库（new-api-gateway）的发布模型：在当前 `main` HEAD 上打一个 semver tag，推到 `origin`，然后用 `gh` 建一个 GitHub release，release notes 用中文、面向使用者总结「能做什么新事情」。历史节奏一直是 minor bump（v0.1.0 → … → v0.10.0）。

发版是**公开且不易撤销**的动作（推送提交、创建公开 release），所以流程里固定有一次「先跟用户确认再执行」的卡点——不要跳过。

## 工作流

### 1. 摸清状态（并行、只读）

一次并行跑掉这些只读命令，把现状搞清楚再动手：

- `git tag --sort=-creatordate | head` → 最近一个 tag（记为 `<last-tag>`）
- `git log --oneline -1 HEAD` + `git status --porcelain` + `git remote -v` → HEAD、工作区是否干净、远端
- `git log --oneline <last-tag>..HEAD` → 自上个 tag 以来的提交
- `git rev-parse HEAD` vs `git rev-parse origin/main` → 本地 main 是否领先远端
- `git ls-remote --tags origin <last-tag>` → 上个 tag 是否已在远端
- `git diff --stat <last-tag>..HEAD | tail -1`、`git diff --name-only <last-tag>..HEAD` 按目录聚合、`git diff --name-only <last-tag>..HEAD -- 'migrations/*.sql'` → 改动规模、涉及区域、是否有新迁移/破坏性迁移

几个判断：
- **HEAD == `<last-tag>`**：没有新东西可发，停下告诉用户。
- **工作区不干净**：先提示用户（stash / commit / 丢弃），不要带脏改动发版。
- **本地 main 领先 `origin/main`**：发版前需要先推 main，否则 tag 指向的提交不在远端默认分支上——这是下面「确认」环节要跟用户敲定的事项之一。
- **diff 里出现破坏性/删表迁移**（看迁移文件名与内容）：在确认环节显式提示用户，这是发版说明里必须高亮的事（参考 v0.7.0 把 0018/0019 destructive migrations 单独说明的先例）。

### 2. 跟用户确认（公开动作的卡点）

用 `AskUserQuestion` 一次性确认两件事，给出推荐项：

1. **版本号**：默认推荐「按现有 cadence 的下一个 minor bump」（如 v0.9.0 → v0.10.0）。仅在用户明确表示到了里程碑稳定度时才考虑 major（v1.0.0）。
2. **本地领先时怎么推 main**：默认推荐「先推 main 再打 tag」（顺序：`git push origin main` → 打 tag 并推送 → 建 release）。另一个选项是「只推 tag 不推 main」，仅在用户清楚后果时选。

版本号和推送策略都定了再执行——这两步决定 tag 名和 release 标题，且推送不可逆。

### 3. 执行

按确认结果顺序执行：

```bash
# 仅当本地 main 领先 origin/main 时
git push origin main

# 打 annotated tag 并推送
git tag -a <version> -m "<version>"
git push origin <version>

# 建 release（notes 用 heredoc，见下方风格指南）
gh release create <version> --title "<version>" --notes "$(cat <<'EOF'
<release notes 内容>
EOF
)"
```

执行完用 `gh release view <version> --json tagName,name,url,isDraft,isPrerelease,publishedAt` 核验：`isDraft: false`、`isPrerelease: false`、`tagName` 正确，并把 release URL 回给用户。

如果 `gh` 未认证，提示用户用 `! gh auth login` 在会话里登录（`!` 前缀让输出直接进对话）。

## Release Notes 风格指南（最重要的部分）

这是本 skill 的核心价值。写 notes 时记住：**读者是网关的使用者/运维/管理员，不是写代码的人**。他们只关心「这次升级我能做什么新事情、有什么变化」——不关心你重构了哪个 helper、加了多少测试、合并了哪个 worktree。

### 思考方式

- **按「用户可感知的功能主题」分组，不要按提交或按文件。** 多个提交常常共同组成一个功能（典型情况：spec → plan → repo 层 → handler → UI → 测试，6~9 个提交其实只是**一个功能**）。把它们合并成一条。
- **先讲能力，再讲具体行为。** 写「Trace 列表新增筛选栏（用户名 / trace_id / token / 需复核）」，不写「feat(admin): escapeILIKE + parseBoolQueryParam helpers」。
- **纯内部改动折叠或省略。** 重构、补测试、仅文档的 plan/spec 文件、helper 改名——放进末尾的「其他」一行带过，或干脆不写。**例外**：如果一个内部改动有用户可感知的效果（比如加了个筛选索引让大列表保持流畅），要写**效果**（列表更流畅），不写迁移名。
- **别编造功能。** 光看 commit subject 判断不准时，读一下对应 diff。忠实反映实际改动——这跟仓库「证据先于断言」的规矩一致。
- **语言：中文**（仓库约定，且历史 release 都是中文）。

### 模板

```markdown
## 概述

一句话说清本次范围 + 提交数/规模。如果是重构、无 API 变更、无破坏性迁移，**显式说明**（参考 v0.8.0「无 API 变更、无破坏性迁移」）。

## 新功能

### 🎯 <功能名>
<1~3 句：用户现在能做什么 / 行为有什么变化。必要时列要点。>

### 🔍 <功能名>
…

## 其他
- <次要修复、文档同步、内部改动，一行一条>

**完整改动**: https://github.com/cqu903/new-api-gateway/compare/<last-tag>...<version>
```

说明：emoji 小标题可选，但和历史 release 风格一致；「其他」是用来兜底那些不值得单独开节、又不该完全隐藏的改动。

### 参考实例

v0.10.0 的 notes 是这个风格的标杆：把 36 个提交（含大量 spec/plan/test/refactor）浓缩成 4 个用户功能节（LLM 离主业检测上线 / Trace 列表搜索筛选 + 跳页 / 异常→Trace 详情直达 / 异常列表分页 + 类型筛选），加一个「其他」兜底，末尾附 compare 链接。可以 `gh release view v0.10.0 --json body -q .body` 调出来对照。

## 边界

- 这个 skill 只管「打 tag + 发 release」。如果用户要的是改代码、改迁移、修 bug，那不在本 skill 范围。
- 不要改写已发布的 tag / release。版本号一旦确认执行就视为定稿。
- 仓库双进程（Go 网关 + Python worker）、Go/Python 契约在 `internal/jobs/` 与 `workers/analysis_worker/models.py`——分析 diff 时留意跨边界的改动，这类改动在 notes 里往往对应一个完整功能而不是两件独立的事。
