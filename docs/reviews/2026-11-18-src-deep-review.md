<!--
  这份报告由本插件自己的动态工作流生成（2026-11-18，真实 DSH Web + workbuddy/deepseek-v4.1-flash，
  4 个阶段、71 个任务）。下面的修复状态是之后补上的；报告正文保持原样。
-->

## 修复状态（2026-11-18）

已修复 20 / 32：全部 High（3）、全部 Medium（14）、Low 中的 3 条。其余 12 条 Low 留作后续。

| 编号 | 状态 | 修复与回归测试 |
| --- | --- | --- |
| H1 | 已修复 | `pathOf` 校验 id（安全路径段）与版本（正整数），下载路由同路径 → `tests/dsh/hardening.ts` |
| H2 | 已修复 | 路由在没有 peer 时用 `connection.admit(req)` 认证；POST 需要已认证的 owner |
| H3 | 已修复 | `dsh_dwf_run_owner` 表 + 心跳：存活 Host 正在跑的 run 不再被当成孤儿 → `hardening.ts` |
| M1 | 已修复 | `assertOwnRun`：amend / fill / resume / stop / resolve 只能由启动该 run 的会话调用 → 集成场景 9 |
| M2 | 已修复 | 下载用 `stat`+`isFile`，流挂 `error` 处理 |
| M3 | 已修复 | 记录失败也一定把答案交给子代理（`finally`） |
| M4 | 已修复 | `state.turn` 链加 `.catch` 记录日志 |
| M5 | 已修复 | `max_concurrency: null` 与 `-1` 都表示恢复默认；仅改设置时原地 retune |
| M6 | 已修复 | rg 与 fallback 排除同一组目录 → `hardening.ts` |
| M7 | 已修复 | rg `--null` 分隔路径 → `hardening.ts`（真实 rg） |
| M8 | 已修复 | run 的取消信号传到 `world.run` / `git.*`；git 有 120 s 超时 → `hardening.ts` |
| M9 | 已修复 | 准入或中止后移除 abort 监听 → `hardening.ts` |
| M10 | 已修复 | `taskCounts` 改用 `workflowRunStepCounts` → `hardening.ts` |
| M11 | 已修复 | 失败的详情请求不再缓存 |
| M12 | 已修复 | 运行面板显示控制失败原因 |
| M13 | 已修复 | 工具卡显示控制失败原因 |
| M14 | 已修复 | 确认卡显示回答失败原因 |
| L1 | 未处理 |  |
| L2 | 未处理 |  |
| L3 | 未处理 |  |
| L4 | 未处理 |  |
| L5 | 未处理 |  |
| L6 | 未处理 |  |
| L7 | 未处理 |  |
| L8 | 未处理 |  |
| L9 | 未处理 |  |
| L10 | 已修复 | `decodeURIComponent` 移入 try，畸形编码返回 400 |
| L11 | 未处理 |  |
| L12 | 未处理 |  |
| L13 | 未处理 |  |
| L14 | 已修复 | 中止时同步治理器的等待计数 |
| L15 | 已修复 | 面板切换 run 时清空旧详情 |

---

# dsh-dynamic-workflow — src/ 深度代码审查报告

> 仓库：`dsh-dynamic-workflow`（本工作区即被审仓库，`src/` 存在）
> 审查对象：`src/` 下全部 `.ts` / `.tsx`（`vendor/` 除外）
> 全程只读，未修改任何被审文件。

## 审查范围与方法

- **范围**：`src/` 下全部 TypeScript 源文件，按目录分组审查（`vendor/` 除外）。本快照实际统计到 45 个 `.ts`/`.tsx` 文件，分布为：`src/client`（11）、`src/service`（8）、`src/driver`（4）、`src/tools`（4）、`src/dsh`（3）、`src/display`（3）、`src/world`（3）、`src/journal`（2）、`src/notify`（2）、`src/web`（2）、`src/governor`（1），根目录 `src/index.ts`、`src/skill.ts`。
- **流程**：对每个目录派发一个审查子代理 → 对每条候选发现派发一个**独立复核子代理尝试证伪**（只有经得起证伪的才保留）→ 去重、按严重程度排序 → 汇总成本报告。
- **复核方式**：复核子代理逐条做代码路径追踪，并对可执行部分做了实跑复现（`node --experimental-strip-types` / `tsx` 直接导入真实源函数、`node:sqlite` 双连接复现 WAL 竞态、真实 `rg` 对比 `fallback`、`node:http` 复现路由行为等），证据记入各条"复核要点"。报告撰写阶段，本代理用 `sed -n` 逐一核对了下列被引用的关键行号（`src/service/artifacts.ts:44-51`、`src/web/routes.ts:60-175`、`src/journal/journal.ts:36-43`、`src/tools/tools.ts:262-294/339-380`、`src/governor/governor.ts:60-150`、`src/driver/driver.ts:531/638-641/663-666`、`src/world/ports.ts:100-135/195-210/275-320`、`src/world/world-read.ts:320-335`、`src/index.ts:88-96/248-262`、`src/skill.ts:14-30`、`src/tools/sources.ts:108-152`、`src/client/{RunPane,RunNode,ConfirmCard,WorkflowToolCard,run-view}.*`），行号与当前源码一致。
- **说明**：本快照未安装 `node_modules`、`vendor/`，`src/shared/runs/*` 在本工作副本中为空；涉及跨包（`dsh-host-webserver`、`@zcode/dynamic-workflow` 引擎等）与 `src/shared` 的证据由复核子代理在完整 checkout 中核对，已在对应条目注明。**未运行**仓库完整测试套件（本次为静态审查+定点评测，不涉及整套测试）。

## 统计

| 严重程度 | 数量 |
| --- | --- |
| Critical | 0 |
| High | 3 |
| Medium | 14 |
| Low | 15 |
| **去重后成立合计** | **32** |

原始共 33 条候补发现；去重合并 1 组（`src/service/artifacts.ts:44-51` 的 `pathOf` 未净化 `id` 与 `src/web/routes.ts:160-162` 的下载路由目录穿越同根因，合并为 H1）→ 32 条成立。

---

## 发现（按严重程度排序：Critical > High > Medium > Low）

### High

#### H1 · `src/service/artifacts.ts:44-51` — 产物路径 `pathOf` 只清洗 `runId`、完全不清洗 `id`：跨 run 覆盖 + 下载路由目录穿越
*(合并自 `src/web/routes.ts:160-162` 的下载路由路径穿越，同根因：`pathOf` 未净化 `id`)*

- **触发**：脚本里写 `artifact.file("..", "x")` / `artifact.markdown("..", ...)`（`id=".."` 能通过编译期 `ARTIFACT_ID_PATTERN=/^[A-Za-z0-9_.-]+$/`）；或已认证客户端请求 `GET /dynamic-workflow/api/artifacts/<run>/..%2FotherRun%2Fart/v3`（`routes.ts:87` 先 `split('/')` 再 `decodeURIComponent`，`%2F` 解码成真实 `/`）。
- **后果**：`id=".."` 时发布写入 artifacts 根目录，造成不同 run 之间同 `id`/同版本互相覆盖（数据丢失/错乱）；下载路由把 `id` 原样交给 `pathOf`，可读取任意 run 的任意版本产物，或读取 artifacts 根之外、文件名恰为 `v<数字>` 的任意可读文件（信息泄露/目录穿越）。
- **复核要点**：`pathOf=(runId,id,version)=>join(root, runId.replace(/[^A-Za-z0-9._-]/g,'_'), id, \`v${version}\`)`，`id` 未做任何处理；`publish` 目标侧无 `within(root,target)` 守卫。实跑：`publish({runId:'dwfrun-abc',id:'..',version:1,...})` 后文件落在 artifacts 根（`root/v1`）而非 `root/<runId>/`；URL `.../artifacts/run1/..%2F..%2F..%2Fsrv%2Fapp/v1` 得 `segments=["artifacts","run1","../../../../srv/app","v1"]`（4 段通过校验），`pathOf` 得 `/srv/app/v1`。注：`runId` 由 `dwfrun-${randomUUID()}` 生成，`runId=".."` 非真实可达路径，真正可达危险源是 `id` 未净化。
- **修复建议**：`pathOf` 内对 `id` 做白名单校验（与 `ARTIFACT_ID_PATTERN` 一致且**显式拒绝 `.`/`..`**），并加 `within(root, target)` 守卫；下载路由对 `id` 段拒绝 `..`/绝对路径，并校验 run 归属；`runId` 正则不应放行纯 `.`/`..`。

#### H2 · `src/web/routes.ts:130-133` — owner 校验依赖的 `peer` 参数在当前 WebServer 契约下恒为 `undefined`，校验形同虚设
- **触发**：任何能连到监听端口的调用方（默认 `127.0.0.1`，同机任意本地进程；或 `--host` 绑非 loopback 时的远端无凭据客户端），携带 `x-dynamic-workflow-request: 1` 头，`POST /dynamic-workflow/api/runs/:runId/stop|resume|retune`。
- **后果**：`peer?.principal?.kind !== undefined` 恒为 false，owner 校验永不拒绝；非 owner 可停止/恢复/调整任意 workflow run（越权控制；`resume` 还会加载 owner agent 续跑对话）。第 75 行的 `auth:'required'` 也不是 `WebRoute` 字段、不被执行。
- **复核要点**：已安装 `dsh-host-webserver@0.2.2-rc.4` 的 `WebRoute.handler` 类型为 `(req,res)=>void|Promise<void>`，dispatch 为 `await responder.handler(req, res)`（`src/index.ts:541` / `lib/index.js:469-471`），第三参从不传入；`register()` 只读 `kind`/`path`（`src/index.ts:445-452`）。插件用 `src/web/routes.ts:71` 把 `webServer` 强转绕过类型检查。该前缀路由绕过 `dsh-client-connection` 的 `/api` 认证，唯一门禁是 `routes.ts:48-52` 的 `sameOrigin()`（CSRF 性质，非身份认证）。注：原"liveshare viewer"示例不成立（viewer 到不了 `/dynamic-workflow`），默认场景实际越权者是本地进程。
- **修复建议**：不要依赖 handler 第 3 参；改用 `resource` 路由拿 `peer`，或在 handler 内自行调用连接层鉴权（`connection.authorize` 等）并检查 principal；移除无效的 `auth:'required'`；在服务端对 `stop/resume/retune` 强制 owner 判定。

#### H3 · `src/journal/journal.ts:36-43` — 冷启动孤儿扫描 `listNonTerminalRunsAll` 按全库非终态取行，会误杀其他进程/桌面实例正在运行的 run
- **触发**：同一个 `$DSH_HOME/state/dynamic-workflow/journal.sqlite` 被两个 DSH 进程/桌面实例共用；第二个进程插件 `apply()` 时执行 `reconcileOrphans()`（`src/index.ts:130`）。
- **后果**：第二个进程把第一个进程仍在前台运行的 run 在共享 journal 里改写为 `stopped(interrupted)`，造成状态错乱：UI 显示已停止、后续被误判为可 resume、可诱发重复运行/伪造 run-settled 事件。
- **复核要点**：`listNonTerminalRunsAll()` 执行 `select id from dwf_run where status not in ('completed','failed','cancelled')`（无 `parent_session_id` 过滤）；`reconcileOrphans`（`run-service.ts:632-644`）只按进程内 `this.live` 判断，非本进程 live 的一律 `updateRunStatus(...,'stopped',{interrupted})`。基类 `zcode/dwf-journal.ts:242` 专门提供按会话过滤的 `listNonTerminalRuns(parentSessionId)` 并注释警告此坑；`schema.ts:84` 以 WAL 打开、多进程共享 `$DSH_HOME` 是 DSH 认可场景。边角夸大：单进程内"兄弟会话"支不成立（单 RunService/单 live），主触发"两进程共享 journal"可达成立。
- **修复建议**：改用带 `parent_session_id`/owner 过滤的 `listNonTerminalRuns`；`reconcileOrphans` 仅在能证明进程确已死亡时收敛，并在 `updateRunStatus` 前复查 `row.status` 终态（见 L3）。

---

### Medium

#### M1 · `src/tools/tools.ts:339-380` — 控制类工具缺少 run 归属校验，可操作其它 session 的 run（HTTP 路由却校验 owner）
- **触发**：session A 先 `list_workflow_runs(all_sessions:true)` 拿到 session B 的 `run_id`，再调用 `stop_workflow_run` / `resume_workflow_run` / `fill_workflow_hole` / `amend_workflow`。
- **后果**：跨 session 的 run 可被任意模型会话停止/补洞/续跑/修订，绕过 HTTP 层强制 owner 的校验，导致他人正在运行的工作流被中断或结果被篡改（隔离/安全问题）。
- **复核要点**：`stop_workflow_run`（`tools.ts:377-379`）`execute: async (args) =>` 不接收 agent，直接 `service.cancel(...)`；`cancel`（`run-service.ts:495-500`）只查 `live` 有无，无归属判断；`resume`/`fillHole` 同样无 owner 校验；`list_workflow_runs(all_sessions:true)` 走 `journal.listRunRows(undefined)` 返回全部。对照 `routes.ts:130-133` 的 HTTP 层有 owner 校验、`SKILL.md §16.4` 承诺"refused"，实现与文档矛盾。`amend` 对非 own run 会走确认窗（默认 `confirm:'ask'`），仅 `confirm:'never'` 或用户点 Allow 时才真正 abort，故 amend 夸大幅度略大，但 stop/resume/fill 无条件可达。
- **修复建议**：给控制工具传入调用方 agent，并在 `RunService.cancel/resume/amend/fillHole` 内校验 `row.parentSessionId === callerSessionId`（无则拒绝），与 HTTP 层一致。

#### M2 · `src/web/routes.ts:163-168` — artifact 下载流未挂 `error` 监听器，读失败会以未捕获 `'error'` 事件崩溃进程（含 `existsSync→open` TOCTOU）
- **触发**：已认证客户端请求 `GET /dynamic-workflow/api/artifacts/:runId/:id/:version`，目标 `pathOf` 结果是目录（如某 artifact `id` 恰为 `v1` 时 `pathOf` 指向目录）或读失败。
- **后果**：`createReadStream(path).pipe(res)` 的异步 `'error'`（EISDIR/ENOENT/EACCES）无监听 → 未捕获异常 → Host 进程 `exit(1)`（远程拒绝服务）。
- **复核要点**：`routes.ts:167-168` `writeHead(200)` 后 `createReadStream(path).pipe(res)`，无 `'error'` 监听；外层 try/catch 抓不到异步事件。实测镜像该逻辑请求目录输出 `HOST UNCAUGHT: EISDIR` 且 `exit=1`；`createReadStream('/nonexistent/...').pipe(dest)` → `UNCAUGHT: ENOENT`；`dsh-app-boot` 的 `onException` → `proc.exit(1)`。夸大处：正常文件下载不触发；TOCTOU 与"断开后读到 EOF 才释放 fd"描述不准（实为断开后停住占 fd，不崩溃）。
- **修复建议**：给读流注册 `'error'` 监听（`res.destroy()`/回 500），改用 `open`+`stat` 或 `pipeline()`（`stream.pipeline` 断开会自动销毁源流）以消除 TOCTOU/句柄滞留。

#### M3 · `src/driver/driver.ts:638-641` — `respondToEscalation` 先删映射/写 journal 再 `resolve`，`record` 抛错会使子 agent 永久阻塞
- **触发**：主 agent 通过 `resolve_workflow_question` 回答一个已 park 的 escalation 时，恰好 `journal.appendEvent` 写失败（IO/磁盘/busy 或 insert 未返回 sequence 显式 throw）。
- **后果**：异常中断函数，`deferred` 永不 `resolve`，子 agent `escalate` 的 await 永不返回（该 turn/run 死锁）；且 qid 已在 registry 标 `resolved`，重答得 `already_resolved`，无法恢复。
- **复核要点**：`driver.ts:633-643` 先 `pendingEscalations.delete`/`qidToSession.delete`，再 `this.record(...)`（`driver.ts:886-889` 无 try/catch），最后 `deferred.resolve`；`escalations.ts:96-97` 先 `retire(qid,'resolved')` 再 `settle`。同文件 `escalate()` 的 escalation-raised 分支（`driver.ts:824-839`）有 try/catch 回滚，此处缺失。注：`deps.emit` 在生产装配下已被 `run-service.ts:318-325` 兜住，但 `appendEvent` 抛错路径足以支撑。
- **修复建议**：用 try/catch 包住 `record`，失败时回滚/仍 `resolve`；或把 `deferred.resolve` 放到 `record` 之前并在 finally 保证 settle。

#### M4 · `src/driver/driver.ts:663-666` — `state.turn` 的 Promise 链没有 rejection 处理，settle 处理器抛错会成为未处理拒绝
- **触发**：某次 turn 结算时，`onTurnSettled/onTurnRejected` 内调用的 `sink.askProgress/askStats/askTurnEnded/askFailed` 或 `snapshotEventsSince/summarizeTurn` 同步抛出（如 journal 写失败、事件异常）。
- **后果**：`state.turn` 成为无人处理的 rejected Promise，Node>=15 默认 `--unhandled-rejections=throw` 可致进程崩溃；至少记账静默丢失、ask 状态不再推进。
- **复核要点**：`state.turn = state.agent.whenIdle().then(onTurnSettled, onTurnRejected)` 是唯一赋值点，全仓无 `.catch`/await（`grep '\.turn\b'` 只命中 663）；`onTurnSettled`（:673-701）/`onTurnRejected`（:709）调用 sink，sink 内部 `record()`（`engine.ts:688-692`）走 `journal.appendEvent`（同步 `node:sqlite`，会 throw）。实测：未处理的 `Promise.resolve().then(()=>{throw})` 在 Node v24.22.3 下进程 exit code 1。
- **修复建议**：`state.turn = ....catch(err => { this.deps.logger?.error(...) })`，或在两个处理器内部包 try/catch。

#### M5 · `src/tools/tools.ts:262-294` — `amend_workflow` 的 `max_concurrency=null`（文档要求"移除限制"）被当继承，并会另起新 run
- **触发**：对仍在运行的 run 调 `amend_workflow { run_id, max_concurrency: null }`（按 SKILL §16.4 想移除并发上限）。
- **后果**：并发上限未被移除（沿用前驱值），且因跳过原地 retune 分支会新起一个 run 重跑同一脚本、并停下旧 run——与用户意图相反，造成重复执行/浪费。
- **复核要点**：`int(null)=undefined`；`tools.ts:264` 原地 retune 要求 `maxArg !== undefined`，null 被跳过；落到 `tools.ts:294` `maxArg === undefined ? predecessor.caps.maxConcurrency : ...` 沿用前驱。`SKILL.md:1512-1515` 明写 `pass null to remove it`，`subagent_model` 传 null 却能正确重置，行为不一致。工具用裸 `ctx.tools.register` 注册、非 `defineTool`，入参不做 schema 校验，`null` 会到达 execute。
- **修复建议**：区分 `null`（移除上限）与 `undefined`（未提供）；用 `Object.hasOwn(args,'max_concurrency') && args.max_concurrency === null` 判定，并让 settings-only retune 分支接受 null。

#### M6 · `src/world/ports.ts:280-285` — ripgrep 分支不排除 `IGNORED_DIRS` 且遵守 `.gitignore`，fallback 相反，`files.glob/grep` 结果随是否安装 rg 而变
- **触发**：工作区无 `.gitignore`（或 `node_modules/.dsh/dist` 未 gitignore）时调用 `files.glob`/`files.grep`；或工作区有被 gitignore 目录时在无 rg 的机器走 fallback。
- **后果**：只读世界读取的返回集合取决于宿主是否装 ripgrep：rg 分支把 `.dsh/node_modules/dist` 内部文件当匹配（撑爆 cap 触发 `WorldReadCapExceeded` 或读到内部文件），fallback 反过来把 gitignore 的文件当匹配；违反"journaled 值必须确定"。
- **复核要点**：`searchFiles` 的 rg 分支仅 `--glob '!.git'`，未用 `IGNORED_DIRS`（第154行）；fallback `walk()`（220-237）跳过 `IGNORED_DIRS` 且不读 `.gitignore`；`searchText` rg 分支（308）同样只排除 `.git`。实跑：含 2100 个 node_modules 文件的工作区，`maxResults=2001` 时 rg 返回 `truncated:true,count:2001`（含 node_modules），fallback 仅 `count:1`；真实 git 仓库 `.gitignore=build/` 时 rg 返回 1 个、fallback 2 个（含 build/gen.ts）。
- **修复建议**：rg 分支补 `--glob '!node_modules' --glob '!.dsh' ...`（与 `IGNORED_DIRS` 对齐）并按需 `--no-ignore-vcs`，使两分支行为一致。

#### M7 · `src/world/ports.ts:311-315` — `searchText` 用非贪婪 `/^(.*?):(\d+):(.*)$/` 解析 rg 输出，文件名含 `:<数字>:` 时路径/行号/文本全错
- **触发**：被匹配的文件名本身含形如 `:数字:` 的片段（POSIX 合法，如 `a:1:b.txt`），经 rg 分支产出 content 命中。
- **后果**：`files.grep` 返回错误 `path`（归一后指向不存在的文件）、错误 `line` 与截断 `text`，该行其余文本被丢弃——静默交出错误数据。
- **复核要点**：`ports.ts:312` 逐行 `/^(.*?):(\d+):(.*)$/`，非贪婪在第一个 `:\d+:` 处断开。实跑：文件 `src/a:1:b.txt` 内容 `needle here`，rg 行 `./src/a:1:b.txt:1:needle here` → 返回 `{path:"src/a",lineNumber:1,text:"b.txt:1:needle here"}`（应为 `src/a:1:b.txt` / `1` / `needle here`）。
- **修复建议**：改用 `rg --json`（或 `--null`）输出解析，避免文件名冒号歧义；或对 `path`/`line` 做 `realpath` 存在性校验。

#### M8 · `src/world/world-read.ts:326-331` — `world.run` / `git.*` 从不向执行端口传 `AbortSignal`，运行级取消无法终止卡住的子进程
- **触发**：脚本给出很大 `opts.timeoutMs` 的 `world.run`，或某个 git 命令在大仓库/NFS/等待锁时挂起，此时触发运行取消。
- **后果**：取消不生效，卡住的子进程只能等超时（git 甚至无超时），子进程、stdout/stderr 管道与监听器长期占用，资源泄漏，与"cancel 是最后的控制"注释语义不符（注：run 记录本身会及时 settle，泄漏的是孤儿子进程/管道）。
- **复核要点**：`ExecutionPort.run` 支持 `signal`（`ports.ts:42/123-127`），但 `worldRun`（`world-read.ts:326-331`）与 `runGit`（198-208）都未传 `signal`，`runGit` 连 `timeoutMs` 都不传；`grep 'signal' src/world` 仅命中 ports.ts。宿主侧 `createNodeExecutionPort`（`run-service.ts:117/330`）spawn 的子进程不是被取消时 `child.kill()` 杀掉的沙箱进程后代。
- **修复建议**：把 `AbortSignal` 经 `WorldReadDeps` 传到 `executionPort.run`；给 `git.*` 增加 `timeoutMs`。

#### M9 · `src/governor/governor.ts:96-101` — 排队准入时注册的 abort 监听器在请求正常准入后从不移除，随 phase 信号累积泄漏
- **触发**：并发 fan-out 到同一 provider/model 桶、配额已满走队列路径，随后正常完成（未 abort）；在长 phase（多步工具调用/重试）内反复发生。
- **后果**：监听器闭包（持有 bucket、waiter、已 settle 的 promise）随排队请求次数线性累积，在 phase 生命周期内不被回收（内存泄漏），直到该 signal 被丢弃。
- **复核要点**：`admit()` 的 `signal?.addEventListener('abort', ..., {once:true})`，正常准入由 `pump()` 的 `queue.shift()!.resolve`（:67-72）完成，`govern()` finally（:141-148）只记账+pump，均不移除监听；`{once:true}` 仅在 abort 时清除。`options.signal` 就是 agent loop 的 per-phase 信号并被同 turn 多步复用（`agent.ts:444/485/496`）。实测（真实 governor.ts，cap=1、6 请求共享同一 signal）：全部正常完成（未 abort）后 signal 仍残留 5 个 abort 监听器，abort 触发后清零。
- **修复建议**：waiter 被 pump 准入或请求结束时显式 `signal.removeEventListener('abort', handler)`；或改用可清理的封装。

#### M10 · `src/client/run-view.ts:104-109` — `taskCounts` 用 `max(nodesUsed, nodes.length)` 当总数，漏掉表外节点导致任务计数偏小
- **触发**：宽 fan-out 使 nodes 表超过 `maxNodes(1024)`，或节点按孤儿规则被摘掉不再派发——运行中的 run 在 run 卡/详情页显示的任务步数低于真实值。
- **后果**：`WorkflowToolCard.tsx` 与 `RunPane.tsx` 的"任务 {done}/{total}"分母偏小（甚至 `total=0` 使整条计数被隐藏），误导用户判断进度。
- **复核要点**：`taskCounts` 的 `total = Math.max(run.usage.nodesUsed, run.nodes.length)`；仓库唯一允许读法 `workflowRunStepCounts`（`workflow-runs-caps.ts:119-126`）为 `total = run.nodes.length + (nodesUnlisted??0)`，其注释明确警告"读面必须都走这一个函数，否则显示得比真实步数小"。`nodesUsed` 仅统计"已派发"节点，`nodesUnlisted` 含尚未派发的 queued 节点（`eviction.ts:516-517`）。实跑：`nodes=1024,nodesUsed=1500,nodesUnlisted=1976` → `taskCounts{total:1500}` vs `workflowRunStepCounts{total:3000}`（`done` 恰等于 settled，唯一错的是 `total`）。
- **修复建议**：直接改用 `workflowRunStepCounts(run)`，与其它读面统一。

#### M11 · `src/client/RunNode.tsx:69-79` — `detailOf` 把失败的 GET 缓存为永久 `null`，瞬时失败后该 revision 的名称/因果图再也不会重试加载
- **触发**：打开 run 后对 `runs/:id` 的某次请求瞬时失败（网络抖动、宿主重启 5xx）。
- **后果**：卡片标题退回 `runId`，Timeline/阶段数/因果图缺失，无错误提示也无重试；仅整页刷新或 run 状态变化产生新 key 才恢复。
- **复核要点**：`details` 是模块级 `Map`，`detailOf` 以 `${runId}#${revision}` 为 key，`apiGet(...).catch(()=>null)` 把失败吞成 null 并存入缓存，仅 `:76` 的 size>64 驱逐会删除条目。RunNode effect 依赖 `[runId,filled,projectedStatus]`，已结算 run 上 key 不变，失败结果被永久复用。缓解：`RunPane` 的"打开详情"独立 `apiGet` 不做失败缓存、`[runId,status]` 变化重试；整页刷新重建 Map。（复核将原 medium 评为偏低，但保留在 structured severity=medium。）
- **修复建议**：失败不缓存 null（仅缓存成功），或失败后删除缓存条目并展示错误/重试入口。

#### M12 · `src/client/RunPane.tsx:94-97` — 侧栏 stop/resume 控制既不 catch 请求异常也不检查服务端 `ok:false`，失败时静默无提示
- **触发**：点击 Stop/Resume 时网络或服务器报错，或服务端以 200 返回 `{ok:false,message}`（如 run 已结算、不可 resume）。
- **后果**：请求拒绝变成未处理 Promise rejection；按钮恢复但既不刷新也不提示，run 实际未停/未恢复，用户无反馈。
- **复核要点**：`RunPane.tsx:94-97` `control` 是 `try{await apiPost(...)}finally{setBusy(false)}`，无 catch、丢弃返回体；`apiPost`（`run-view.ts:125-132`）对非 2xx 抛错；服务端 `cancel`/`resume` 失败为 HTTP 200 的 `{ok:false,message}`。对照 `RunNode.tsx:106-114` 同时做了 catch→`setNotice` 与 `ok===false` 判定，此处遗漏；`src/` 无全局 `unhandledrejection`/ErrorBoundary 兜底。
- **修复建议**：加 `catch` 与 `ok:false` 检查，设置 notice 提示（对齐 `RunNode`）。

#### M13 · `src/client/WorkflowToolCard.tsx:78-86` — 工具卡 stop/resume 控制同样吞掉异常与 `ok:false`，失败静默
- **触发**：点击 Stop/Resume 时请求抛错，或服务端以 200 返回 `{ok:false, message}`。
- **后果**：未处理 Promise rejection；按钮恢复但 run 未停/未恢复、界面无任何提示，静默失败。
- **复核要点**：`WorkflowToolCard.tsx:78-86` `control` 仅 `try{await apiPost(...)}finally{setBusy(false)}`，无 catch、丢弃返回体；`apiPost`（`run-view.ts:125-132`）非 2xx 抛错；`routes.ts:128-158` 的 403/409 与 200+`ok:false` 两条路径都可达。组件无 notice 状态，`src/` 无全局兜底；对照 `RunNode.tsx:106-114` 证明是遗漏。
- **修复建议**：同 M12，加 catch + `ok:false` 处理与提示。

#### M14 · `src/client/ConfirmCard.tsx:72-80` — 确认回答 `answer()` 未捕获 `pending.answer` 的拒绝，点击失败只产生未处理 rejection、无提示
- **触发**：点击 Allow/Deny/Always allow/Refine 发送后，`pending.answer` 因通道关闭竞争或 RPC 失败而 reject。
- **后果**：未处理 Promise rejection；UI 无错误提示，用户会重复点击反复失败（确认卡是运行工作流前的闸门）。
- **复核要点**：`ConfirmCard.tsx:72-80` `answer` 仅 `try{await pending.answer(...)}finally{setSending(false)}`，无 catch；所有调用点 `void answer(...)`（:114/119/125-127）。`PendingQuestion.answer` 存在三条 reject 路径（`dsh-client-ui-user-questions/.../slots.ts:528-540`）；同框架官方 UI（`QuestionComposer.tsx:403-415`、`PlanReviewPanel.tsx:34-46`）均显式 `.catch(setError)`，本组件无 error 状态、`src/client` 无全局兜底。
- **修复建议**：给 `answer` 加 `catch`，设置 error 状态提示（参考 `QuestionComposer`）。

---

### Low

#### L1 · `src/index.ts:253-258` — 插件卸载清理未 `await service.close()`/`db.close()`，SQLite 句柄与运行收尾被脱离生命周期
- **触发**：宿主热重载/禁用插件或进程退出时触发 `ctx.effect` 的 disposer，此时仍有 live run 或 db 未关闭。
- **后果**：卸载后旧 `DatabaseSync` 句柄仍未关闭，重载新实例与旧句柄并发打开同一 SQLite（WAL+锁竞争）；进程随即退出可能截断收尾写入，journal 残留 running（下次被 `reconcileOrphans` 记为 interrupted）。危害偏轻：`service.close()` 仍会 abort live run 成 interrupted，WAL+busy_timeout 支撑并发打开。
- **复核要点**：`index.ts:253-258` disposer 为块体箭头 `() => { ... void service.close().finally(()=>{db.close()}) }`，内层无 return，返回 undefined。Cordis `fiber.d.ts:39`「they may be async, in which case unloading awaits them」；实测 void disposer 时 `dispose()` 先于异步 close 返回。
- **修复建议**：改为 `return service.close().finally(...)`，使卸载 await 收尾。

#### L2 · `src/index.ts:91-93` — SQLite 句柄在开启后才依赖末尾的 `ctx.effect` 关闭，初始化中途抛错会泄漏句柄/WAL
- **触发**：插件初始化阶段任一 setup 步骤抛异常（工具/路由重复注册、journal 查询失败等）。
- **后果**：`DatabaseSync` 句柄及 WAL/SHM 不会被关闭，插件激活失败后无人清理（句柄挂到 GC 才回收；GC/退出会清 -wal/-shm，非永久磁盘泄漏）。
- **复核要点**：`index.ts:93` 打开 DB，唯一 `db.close()` 在 `:256` 的末尾 effect；`:93-252` 无 try/catch。Cordis `_reload` 捕获 apply 抛错后只 dispose 已注册 effect，`db.close` effect 尚未注册故不清理。
- **修复建议**：用 try/catch 包住 `:93-252`，失败时 `db.close()` 后再抛。

#### L3 · `src/journal/journal.ts:38-42` — `listNonTerminalRunsAll` 的"先查 id 再逐条 `getRun`"非原子，可能返回已终态记录并被改写成 interrupted
- **触发**：另一连接/进程在 `SELECT id` 与 `getRun` 之间把某 run 结算为终态（多进程 WAL 下可发生）。
- **后果**：一个已正常完成的 run 状态被覆盖为 `stopped(interrupted)`（状态面错乱、变为 resumable 可被再次 resume）；原始 result 数据未丢。
- **复核要点**：`journal.ts:38` 先 `select id ...`、`:40` 再 `getRun(id)`；`reconcileOrphans`（`run-service.ts:634-641`）`updateRunStatus` 前不复查 `row.status`。基类 `listNonTerminalRuns` 用单条 `select * ... where status not in (...)` 原子取行；ZCode 参考实现 `dynamic-workflow-run-reconcile.ts:83-85` 有 `if (TERMINAL_RUN_STATUSES.has(record.status)) continue;`。实机双连接复现：快照=[r1] → 连接B 结算 r1 completed → 连接A `getRun` 读到 completed → 被写成 stopped(interrupted)。
- **修复建议**：改单条原子 SQL 取整行，或 `getRun` 后复查终态再写。

#### L4 · `src/service/artifacts.ts:72-84` — `artifact.file` 发布存在 `realpath→stat→copyFile` 的 TOCTOU 符号链接竞态，可把工作区外文件拷进产物库
- **触发**：工作区内并发的实体（子代理/脚本）在发布期间把路径中的中间目录替换为指向工作区外的符号链接，且落在 `:74` 的 `realpath` 之后与 `:84` 的 `copyFile` 之间。
- **后果**：工作区沙箱边界被绕过，工作区外任意文件可被复制进产物库并经下载路由读取（信息泄露/沙箱逃逸）。实现难度较高（需恶意子代理配合+抢窄竞态）。
- **复核要点**：`artifacts.ts:74 realpath` → `:78 within(realpath(cwd), real)` 校验 → `:79 stat` → `:84 copyFile(real,target)`，多个 await 窗口且之后无再校验。子代理以 `meta.cwd=this.deps.cwd`、`access='full'` 创建且可并发（`run-service.ts:123`）；`world.run` 直接 unsandboxed。用忠实复刻脚本（同样 realpath/stat/copyFile、同样替换点）在 realpath 后替换中间目录为符号链接，成功把工作区外 SECRET 拷入 target（`node /tmp/toctou_repro.mjs`）。
- **修复建议**：用 `open(O_NOFOLLOW)`+`fstat`+基于 fd 的读取/拷贝；或在最终打开时再校验 `within`，避免按字符串路径二次解析。

#### L5 · `src/service/fill.ts:66-68` — fill 时 `compileProgram` 抛出的 schema 诊断未被捕获，绕过结构化的 `compile_failed` 结果，以裸 Error 拒绝整个 fill
- **触发**：`fill_workflow_hole` 的 body 中新增一个 `ask<...>`，其返回类型让 `synthesizeAskSchemas` 产生诊断（analysis 阶段不检查该项）。
- **后果**：本应返回结构化 `compile_failed`（带 body 行号映射诊断）的路径变成抛裸 Error；模型/工具层收到异常而非"编译失败、留白仍在等待"的可操作结果。留白状态不被破坏。
- **复核要点**：`fill.ts:51 analyzeWorkflowScript` 通过后在 `:66` 调 `compileProgram`（`compile.ts:80-83` 内 `synthesizeAskSchemas` 有诊断时 `throw new Error`）；`analyzeWorkflowScript` 不调用 `synthesizeAskSchemas`。实跑：body 内 `ask<Date>` → `analyze ok=true`、`synthesize 诊断 9002`、`compileProgram THREW`。异常未被 fillOnce（`fill.ts:32-34` 的 turn）或 `tools.ts:346` 捕获。对照 `run-service.ts:262-267` resume 路径已有 try/catch 兜住，属遗漏。
- **修复建议**：用 try/catch 包 `compileProgram`，转成 `{ok:false, reason:'compile_failed', diagnostics:...}`。

#### L6 · `src/skill.ts:22` — 解析 frontmatter 的 `JSON.parse` 无保护，畸形引号值会让 skill 注册整体失败
- **触发**：有人编辑打包的 `SKILL.md`，使某双引号 frontmatter 值含未转义 `"` 或非法 JSON 转义。
- **后果**：`JSON.parse` 抛 `SyntaxError`，`ctx.inject` 回调抛出，skill 未注册；skill gate 因拿不到已加载 skill 而拒绝主要创作工具（静默失效）。触发属维护期输入，概率低。
- **复核要点**：`skill.ts:19-22` `field()` 对双引号包裹值直接 `JSON.parse(line)`，`loadSkillContent` 无 try/catch；`index.ts:193` 在 `ctx.inject(['skills'])` 回调内同步调用。实测含未转义 `"` 与 YAML-only 转义均抛 `SyntaxError`。Cordis 子 fiber 捕获记 `logger.error`，父插件仍加载但 skills 未注册；`skill-gate.ts:40` 要求 `isError!==true`，`tools.ts:141 gate()` 抛 428。（措辞修正：日志为 `logger.error` 非 warn；save_workflow 未接 gate。）
- **修复建议**：`JSON.parse` 加 try/catch，失败回退为原始字符串。

#### L7 · `src/tools/sources.ts:111-135` — `findSaved` 在 `listSaved` 去重后按 scope 过滤，显式 `global` 取不到被 project 遮蔽的同名工作流
- **触发**：项目 `.dsh/workflows/` 与全局 `$DSH_HOME/workflows/` 存在同名工作流，调用 `create_workflow { saved:{name:X, scope:'global'} }` 想跑全局那份。
- **后果**：`found` 恒为 undefined，返回 `No saved workflow named X`——显式 `scope=global` 无法访问被 project 遮蔽的全局版本（功能缺失/静默拒绝）。
- **复核要点**：`listSaved`（`:111-130`）用单 Map 按 name 合并，先 global 后 project，project 覆盖 global；`findSaved`（`:132-135`）在已去重列表上 `item.scope===scope` 过滤，末尾 `?? (scope===undefined?undefined:undefined)` 恒 undefined。实跑（fixtures 同名 project+global）：`listSaved` 只返回 project；`findSaved(cwd,'X','global')` → null（global 文件存在）。无 rg 情况仍可经 `path` 运行，属降级。
- **修复建议**：`findSaved` 在未去重的原始列表中按 scope 查，或按 scope 分别 list。

#### L8 · `src/tools/sources.ts:142-150` — `resolveSavedArgs` 用 `??` 取值，显式传入的 JSON `null` 参数被当成缺省丢弃
- **触发**：saved 工作流声明了一个 `json`/可选参数，模型在 `saved.args` 里显式传 `null`（表示"不设置"）。
- **后果**：该参数被静默替换为默认值，或被判为 required 缺失而报错，与显式 null 语义不符。
- **复核要点**：`sources.ts:142` `const value = given?.[key] ?? spec.default`；`:143` `if(value===undefined)` 进 required-missing/跳过；`:147` 类型检查排除 `'json'` 且在 `??` 替换之后。实测 `({pr:null})['pr'] ?? 'x'` → `'x'`。`tools.ts:160` 的 args schema 未禁止 null，`tools.ts:183` 原样传入。
- **修复建议**：用 `key in given`/`=== undefined` 判断缺省，保留显式 null。

#### L9 · `src/tools/tools.ts:173-181` — `create_workflow` 对 `saved=null` 直接读取属性而抛 TypeError（运行时不校验入参）
- **触发**：模型对 `create_workflow` 传入 `saved: null`。
- **后果**：以晦涩的 `TypeError: Cannot read properties of null`（isError 结果）失败，而非清晰的参数错误；且 `null` 也被误计为一个来源。
- **复核要点**：`tools.ts:173` `filter(v=>v!==undefined)` 中 `null!==undefined` 为真 → 计为来源；`:179` `if(args.saved!==undefined)`（null 满足）→ `:180-181` 读 `saved.name` 抛错。插件用裸 `ctx.tools.register`（非 `defineTool`），入参不做校验；`pipeline.ts` 直接 `tool.execute(exec.arguments,exec)`。已用 node 复现 `saved:null` 抛该 TypeError。
- **修复建议**：先校验 `args.saved` 为对象再读属性；`saved:null` 视为非法或不计来源。

#### L10 · `src/web/routes.ts:87` — `decodeURIComponent` 在 `try` 之外执行，畸形百分号编码抛出的 `URIError` 逃逸出本 handler 的错误处理
- **触发**：请求路径含畸形百分号编码，如 `GET /dynamic-workflow/api/runs/%E0%A4%A`。
- **后果**：绕过本路由的 JSON 错误契约，客户端收到无 body 的裸 400；本 handler 的 catch 抓不到（次要"进程内直接调用则未处理 rejection"属推测，无依据）。
- **复核要点**：`routes.ts:87` `split('/').map(decodeURIComponent)` 在 `try {`（:89）之前；`decodeURIComponent("%E0%A4%A")` 抛 `URIError`。实跑镜像 `handle()+catch`：请求返回 `status=400`、body 空、`OUTER CATCH: URIError ... headersSent=false`（`dsh-host-webserver` 外层 catch 兜底）。
- **修复建议**：把解码移入 `try`，捕获 `URIError` 返回 JSON 400。

#### L11 · `src/world/ports.ts:109-128` — `spawn` 同步抛错时 `finish()` 访问尚未初始化的 `timer`/`onAbort`，抛 ReferenceError
- **触发**：`world.run("")`（空串）或 `world.run("node",["\u0000"])`（参数含 NUL），`spawn` 同步抛 ERR_INVALID_ARG_VALUE，进入 catch 调用 `finish`。
- **后果**：本应返回 `status:'spawn_error'` 并由 `worldRun` 归一成可 catch 的 `DriverError`，实际 Promise 以 `ReferenceError` 拒绝，错误类型误判、报错信息不可读。仅在畸形命令时触发。
- **复核要点**：`finish`（`:109-115`）在 `:112` 读 `timer`、`:113` 读 `onAbort`，而 `const onAbort` 在 `:123`、`const timer` 在 `:128` 才声明。实测 import 真实 `ports.ts` 的 `createNodeExecutionPort`，`file:''` 与 `file:'node',args:['\u0000']` 均 REJECTED `ReferenceError: Cannot access 'timer' before initialization`。`requireStringArg` 只判 `typeof==='string'`（空串通过）。
- **修复建议**：把 `timer`/`onAbort` 用 `let` 提前声明（在 `finish` 之前）。

#### L12 · `src/world/ports.ts:199-206` — `globToRegExp` 不翻译 glob 的 `[!...]` 取反语义，fallback 下 `files.glob/grep` 的 glob 匹配相反
- **触发**：使用含 `[!...]` 字符类的 glob，且工作区没有 ripgrep（走 fallback：`searchFiles:287`、`searchText:321`）。
- **后果**：`files.glob`/`files.grep(glob)` 返回与 glob 语义相反的文件集合（静默错误），且与装有 rg 的机器结果不一致。
- **复核要点**：`ports.ts:199-206` `[` 分支把 `[...]` 原样拼进正则，未把 `[!x]` 译成 `[^x]`。实测 `globToRegExp('[!a]bc.txt')` 对 `abc.txt=true`、`xbc.txt=false`、`!bc.txt=true`；对照 `rg --glob '[!a]bc.txt'` 输出 `xbc.txt,!bc.txt,bbc.txt`（不含 `abc.txt`）。端到端 fallback 返回 `["!bc.txt","abc.txt"]`，与 rg 相反。
- **修复建议**：把 `[!...]` 翻译为 `[^...]`。

#### L13 · `src/driver/driver.ts:531` — `instanceToSession` 只增不删，长 run 中持续泄漏
- **触发**：同一 run 中反复对 actor 发起大量 ask（长工作流）。
- **后果**：`instanceToSession` 无界增长，内存随 ask 数持续累积（Map 键串与槽位；value 指向的 ActorState 本已被 sessions 持有，属真实但轻微的无界累积）。
- **复核要点**：`driver.ts:531` 写入；`respondToSubmit`（:551）/`cancelAsk`（:574）只 get 不删；全仓 `instanceToSession` 只有 `:181` 声明、`:531` set、`:551/:574` get、`:614` clear（dispose）。每个 ask 新键（`nextOrdinal` 递增），无总 ask 上限。对照 `qidToSession/pendingEscalations` 会及时 delete，证明是遗漏。
- **修复建议**：ask 完成/取消时从 `instanceToSession` 删除对应键。

#### L14 · `src/governor/governor.ts:96-101` — abort 回调从队列删除 waiter 后未同步 `controller.waiters_` 计数，可导致无需求时的多余扩流
- **触发**：队列中 waiter 因 abort 被移出且队列变空，紧接着某请求完成时的 `succeeded` 恰好凑满 4 连成功（且 `cap<growthLimit`）。
- **后果**：在并无真实排队需求时把 `cap +1`（多余扩流），提高后续撞 429 概率；属轻微状态不一致。
- **复核要点**：`:96-101` abort 回调只做 `splice`+`reject`，不调用 `controller.waiters(...)` 也不 pump（全仓 `.waiters(` 仅 `:72`/`:95` 两处）。`govern()` 在 `:113 await this.admit(...)` 抛出于 try 之前，其 finally 不执行。`ConcurrencyController.succeeded` 用 `waiters_ <= 0` 判需求（`concurrency.ts:156`），`finally` 先 `succeeded`（:143）再 pump（:147）。实测真实控制器：`waiters_=1` 陈旧 + 4 次成功后 `cap 2→3`（reason recovered）。
- **修复建议**：abort 回调内调用 `bucket.controller.waiters(now, bucket.queue.length)` 并触发 pump。

#### L15 · `src/client/RunPane.tsx:81-93` — 侧栏切换 run 时 `RunDetailView` 复用旧 `detail` 状态，短暂用上一个 run 的名称/图/脚本并按旧 snapshot 误判运行状态
- **触发**：侧栏已显示 run A（detail 已加载），通过 tab 参数变化把 `selected` 改为 run B，`RunDetailView` 不卸载、`runId` 变了但 `detail` 未重置。
- **后果**：新 run 详情返回前，界面短暂显示 run A 的标题/因果图/脚本，并可能把 B 的状态显示成 A 的终态（短暂隐藏 Stop）。两端（成功/失败）都会自愈，属瞬态错显。
- **复核要点**：`RunDetailView` `useState` 持有 detail（`:81`），effect 依赖 `[runId,status]`（`:86-91`）但 `runId` 变化不重置 detail；父级 `<RunDetailView runId={selected}>` 无 key。tab 复用同一 tabId（`openTabIn` 无 multi）→ RunPane 不卸载。`reconcileRun(projected_B, detail_A.snapshot)` 会用 A 的终态覆盖 B。已证伪两点：旧请求被 `controller.abort()` 拦住不会迟到写入；失败回调 `setDetail(null)` 会使 `reconcileRun` 回落正确值。
- **修复建议**：`runId` 变化时重置 `detail` 为 undefined，或给 `RunDetailView` 加 `key={selected}`。

---

## 局限与未覆盖

- **静态为主**：本审查以静态代码阅读为主，复核子代理只对部分可执行点做了定点实跑（`node`/`tsx` 导入真实函数、`node:sqlite` 双连接、真实 `rg` 对比、镜像 `node:http` 路由等）；**未运行**仓库完整测试套件（`npm test` 等），因此端到端/集成层面的回归未覆盖。
- **复核只做证伪**：复核流程的目标是"尝试证伪并保留"，只验证"是否成立"，不追求发现新的、更深的缺陷；可能仍有未被列出的问题。
- **环境限制**：本快照未安装 `node_modules`、缺失 `vendor/`，`src/shared/runs/*` 在本工作副本为空；涉及跨包（`dsh-host-webserver`、`@zcode/dynamic-workflow` 引擎、`dsh-client-ui-user-questions` 等）与 `src/shared` 的结论由复核在完整 checkout 中核对，个别行号存在版本漂移，已在条目中注明。
- **运行时未覆盖**：并发/时序类缺陷（如 H3、L3、L4、M9）依赖特定时序，静态无法穷尽；多进程/桌面实例共享 `$DSH_HOME`、非 loopback 部署、子代理不可信等部署前提会显著放大相关问题的实际影响。
- **行为假设**：部分结论依赖宿主（DSH 运行时）行为假设（如是否存在全局 `unhandledRejection` 处理器、`dsh-host-webserver` 契约），已按可读源码判断，打包产物若有差异需以实际运行为准。
