# 用 SoduWork 跑完一次真实交付：从需求、执行到验收的全链路实战

> 这次不谈概念。我挑了一件自己确实要做的事——把一个陌生仓库里散落的文档，做成新人能按图索骥、并能自己证明"没漏"的上手包——然后完整走一遍 SoduWork 的需求池、Agent 执行、人工验收和经验沉淀。全程 70 张截图，本文选用 34 张实战截图与 3 张量化图。人做了什么、Agent 做了什么、每个确认点落在哪里，都有据可查。

> **时间说明**：本文记录 2026-11-25 的一次真实交付。当时仓库 `docs/` 下有 24 篇 Markdown、加根 README 共 25 份材料，文中的截图、断言数量与时间账都对应这一次实测；后续文档增补不影响这套流程本身。
## 一、先选一件真事，而不是玩具任务

新人入职第一天最怕的不是文档少，而是文档多却不知道从哪读起。SoduWork 仓库里 `docs/` 有 24 篇 Markdown，加根 README 共 25 份材料。把它们变成"必读 / 选读 / 实操"三段路线，还要能核对一篇没漏——这件事我确实需要，而且结果可以验证。

我给它定的验收标准只有两条粗线：

1. 交付索引、路线、验证脚本、复用说明四类文件，全部落在 `onboarding/`；
2. 验证脚本至少 8 条断言并输出 PASS，材料原文零改动。

粗线先写，细口径留给"安排执行"时的补充内容。**人定义什么叫做完，Agent 负责把它做完**，这个分工从第一分钟就定下来。

## 二、先把项目跑起来：隔离、端口与两个真实的坑

我没有复用任何既有实例的数据。新实例用独立数据目录 `SoduWork实战/data`、独立端口 `19031`，启动命令只多两个参数：

```powershell
# 独立实例：数据目录与端口都和默认实例隔离
python start.py --data-dir .\SoduWork实战\data --port 19031
```

就这两个参数的意义在于：**实验的每一条数据（需求卡、会话记录、交付物）都落在这个目录里，随时可以整目录归档或删除，不污染任何既有环境。**

![依赖安装阶段：首次启动在独立数据目录里创建 venv、安装 Hub/Runner 依赖](https://imgbed.devzoo.top/images/2026/11/25/d85dd30a62b54f58.png)

启动器把 Hub、管理端和桌面端都拉起来，终端打印出就绪地址与管理员账号。

![终端输出：SoduWork is ready，管理页面地址与管理员账号](https://imgbed.devzoo.top/images/2026/11/25/aaad24dd294444c0.png)

![浏览器打开管理端介绍首页，点击「进入管理后台」](https://imgbed.devzoo.top/images/2026/11/25/24b54527f62b436e.png)

![治理总览：服务运行正常，Hub 版本与构建信息](https://imgbed.devzoo.top/images/2026/11/25/528cca4b2fc040bf.png)

要让 Agent 真能干活，还得在管理端接一个 OpenAI 兼容的对话模型：服务地址、密钥、再加一个准确模型 ID。**接了服务不等于有模型**，这是配置页面上写得最清楚的一句提示。

![模型目录：服务 10 个、配置完整 1 个，已加入 deepseek-flash 对话模型](https://imgbed.devzoo.top/images/2026/11/25/f7c11d5d52a6436b.png)

桌面端登录页显示连接的是同一个 `127.0.0.1:19031`，两端必须指向同一个 Hub。

![桌面客户端登录页：连接地址为本地 19031](https://imgbed.devzoo.top/images/2026/11/25/bcee55ecdf4e40c2.png)

![桌面端登录后：新对话界面，执行底座 Pi，模型 DeepSeek Flash](https://imgbed.devzoo.top/images/2026/11/25/822b366d5fed4e2c.png)

这里遇到两个真实的坑，值得单独记：

- 桌面端首次准备要下载 Electron 运行时，网络超时失败。做法不是硬重试，而是复用本机已经下载好的运行时，并把依赖戳记写回实例目录。
- 紧接着 PortableGit 下载又超时。同样复用本机已就绪的 shell runtime，然后重新启动。

这两步都不是业务逻辑，但**不解决它们，后面所有"全生命周期"都停在起跑线**。我把它们列为环境准备清单的前两条。

## 三、把材料放进隔离现场

材料的处理原则很简单：只读源，单独写产物。我把 `docs/` 与根 README 复制到执行现场的 `source/`，人写的任务说明放在旁边，Agent 只能往 `onboarding/` 写。

```text
source/
├── docs/                  # 24 篇材料（只读源）
├── README.zh-CN.md        # 根 README（只读源）
├── 任务说明.md             # 人写的目标与验收口径
└── onboarding/            # Agent 唯一允许写入的目录
    ├── onboarding_index.json
    ├── ONBOARDING.md
    ├── verify_onboarding.py
    ├── reuse_notes.md
    └── verify_result.json
```

边界用目录划出来，比用提示词反复强调可靠得多——**源和产物物理隔离，"材料零改动"才有了可核对的含义**。

![执行现场准备：24 篇 docs、1 份 README 与任务说明就位](https://imgbed.devzoo.top/images/2026/11/25/4bcaa185688048f8.png)

## 四、需求入池：人写目标与粗验收

![新建需求表单：标题、背景、完成标准与基本信息](https://imgbed.devzoo.top/images/2026/11/25/e03afc78ca8c496e.png)

需求卡提交后进入收集箱，状态"待开始"，创建人和负责人都是我。

![需求入池：需求池出现一张待开始的需求卡](https://imgbed.devzoo.top/images/2026/11/25/1a8f86f573d749ff.png)

详情面板把目标、完成标准、验收与交付分区呈现。**这张卡就是后续所有交接的上下文**，Agent 不需要我再口头解释背景。

![需求详情：背景、两条完成标准、验收与交付区](https://imgbed.devzoo.top/images/2026/11/25/d1fc5483025c4cbc.png)

### 人在这个节点做了什么

- 选了真实任务，而不是"帮我写个 demo"；
- 给出材料位置和写入边界；
- 定了两条可判定的完成标准；
- 明确四类交付物，但没有替 Agent 写任何一类。

这是一个人工确认节点：**需求方确认验收标准**。

## 五、安排执行：把口径写进派单，而不是留在脑子里

需求从"待开始"推进后，卡上出现"安排执行"入口。

![需求推进到待开始，出现安排执行入口](https://imgbed.devzoo.top/images/2026/11/25/1d7586b50e0c44a1.png)

派单面板里，我选的是"交给 AI"：执行底座 Pi、本机、模型 deepseek-flash，交付提交方式按交付物自动判断。关键在"补充内容"——我把四类文件名、14 条下限、UTF-8、材料零改动全部写进派单，而不是等 Agent 做完再补要求。

```text
补充内容（原样写入派单）：
1. 交付物固定四类，落在 onboarding/：onboarding_index.json、
   ONBOARDING.md、verify_onboarding.py、reuse_notes.md
2. verify_onboarding.py 不少于 14 条断言，输出 PASS 计数，
   失败非零退出；结果写 verify_result.json
3. 索引须覆盖 docs/ 全部 Markdown 与根 README，逐条含
   file/title/h1/sections/wc/level 六字段
4. 全部文件 UTF-8；不得改动 source/ 下任何材料原文
```

![安排这条需求：交给 AI，选择插件、Agent、模型与交付方式](https://imgbed.devzoo.top/images/2026/11/25/2a55f307149045e4.png)

确认后，桌面端立刻新建会话并开始执行。

![Agent 接单：需求原文与补充口径一并带入新会话](https://imgbed.devzoo.top/images/2026/11/25/d738be6f43724c5e.png)

这里还有一个交叉点：**同一个面板还有"转给同事"页签**。也就是说，一件需求既能交给 Agent，也能交给人；两种执行方式共用同一张需求卡、同一套验收标准。

## 六、Agent 执行：看过程，而不只看结论

Agent 的第一步不是写代码，而是勘察材料：先统计文档数量，再抽标题与一级章节。

![Agent 正在枚举材料、确认 H1/H2 口径](https://imgbed.devzoo.top/images/2026/11/25/f788e1f6cc8a41d4.png)

中间它反复确认材料结构与口径，包括把一级标题判断从"任意 H2"修正为"H1 优先、H2 兜底"。这类判断留在会话里，事后可回看。

![Agent 持续执行：确认关键文档与入线分类](https://imgbed.devzoo.top/images/2026/11/25/67976b65562d4bd6.png)

随后开始落盘第一份产物：索引 JSON。

![第一份产物生成：onboarding_index.json 落盘](https://imgbed.devzoo.top/images/2026/11/25/5455be0d08874c3c.png)

索引是整包的唯一事实源，每条材料六个字段：

```json
{
  "entries": [
    {
      "file": "docs/architecture.md",
      "title": "总体架构",
      "h1": "总体架构",
      "sections": ["分层职责", "数据流", "扩展点"],
      "wc": 3184,
      "level": "必读"
    }
  ]
}
```

`wc` 是 UTF-8 解码后的字符数，后面脚本会拿它和实际文件逐字核对——**索引里任何一个数字编不出来，都会在断言 7 上现形**。

四类交付物陆续齐备：索引、路线图、复用说明、验证脚本，再加一份验证结果。

![四类交付文件齐备：索引、路线、复用说明、验证脚本与结果](https://imgbed.devzoo.top/images/2026/11/25/c618d11ac8ea464a.png)

![验证脚本内容：14 条断言与三个复用参数](https://imgbed.devzoo.top/images/2026/11/25/475945365f69458e.png)

脚本头部就是三个复用参数，换仓库只动这一块：

```python
# ---- 复用需改的 3 个参数 -------------------------------------
ONBOARDING_DIR = Path(__file__).resolve().parent
SOURCE_ROOT = Path(os.environ.get("SODUWORK_ONBOARD_SOURCE_ROOT",
                                  ONBOARDING_DIR.parent))
DOCS_SUBDIR = "docs"
REQUIRED_FILES = [
    "onboarding_index.json",
    "ONBOARDING.md",
    "verify_onboarding.py",
    "reuse_notes.md",
]
```

14 条断言里最要紧的三条，贴出来看它们各自堵住了什么漏洞：

```python
# 断言 3：索引必须覆盖全部材料，多一篇少一篇都会给出 diff
record("index_covers_all_materials",
       actual_files == idx_files,
       f"actual={len(actual_files)} vs indexed={len(idx_files)}, "
       f"diff={sorted(actual_files ^ idx_files)}")

# 断言 7：索引里的字数逐篇与实际文件核对，防索引凭空编造
if len(read_text(p)) != int(e.get("wc", -1)):
    wc_mismatch.append(rel)

# 断言 13：材料零改动——对基线逐文件比 sha256，有改动就点名
got = hashlib.sha256(p.read_bytes()).hexdigest()
if got != expected:
    changed.append(rel)
```

汇总逻辑同样值得看一眼：**PASS 计数、FAIL 明细、SKIP 单独记账，退出码只看 FAIL**：

```python
fails = [(n, d) for n, ok, d in results if ok is False]
skips = [n for n, ok, _ in results if ok is None]
passes = [n for n, ok, _ in results if ok is True]
...
sys.exit(0 if fails == [] else 1)
```

SKIP 的设计是有意的：材料零改动依赖基线文件，没提供基线时这条不冒充 PASS，也不算失败，而是明确记成 `SKIPPED`——**门禁里不允许"没查=通过"这种模糊地带**。

Agent 自报的结果是 `PASS 14 / 14 (FAIL 0, SKIP 0)`。但**自报不算数**——我另开终端，独立跑了一遍它写的脚本。

![人工在独立终端运行 verify_onboarding.py，逐条 PASS、退出码 0](https://imgbed.devzoo.top/images/2026/11/25/091d072aae644b8f.png)

独立重跑的命令和输出节选（`$LASTEXITCODE` 是 PowerShell 里拿上一个进程退出码的正规姿势）：

```powershell
$env:SODUWORK_ONBOARD_BASELINE = "D:\...\baseline.json"
python onboarding\verify_onboarding.py
echo "exit=$LASTEXITCODE"
```

```text
[PASS] delivery_dir_exists ...
[PASS] four_delivery_files_exist  missing=none
[PASS] index_valid_json
[PASS] index_covers_all_materials  actual=25 vs indexed=25, diff=[]
[PASS] index_wordcount_matches  mismatch=none
[PASS] materials_unchanged_baseline  changed=none
------------------------------------------------------------
PASS 14 / 14  (FAIL 0, SKIP 0)
exit=0
```

注意这里是**人在验收方视角第二次执行同一脚本**——Agent 执行过一遍，我再来一遍。脚本是同一份，意义不同：第一次证明 Agent 能跑通，第二次证明任何人拿同一份材料都能复现。可复现，才算交付。

Agent 的交付回执把文件路径、验证输出、材料基线结果一次列清。

![Agent 交付回执：文件清单、PASS 14/14、材料 changed=none](https://imgbed.devzoo.top/images/2026/11/25/73e206d86cc444a6.png)

### 交付物到底有什么用

| 文件 | 作用 | 谁验证 |
|---|---|---|
| `onboarding_index.json` | 25 份材料逐条记录文件、标题、一级章节、字数、入线等级 | 脚本核对覆盖率与字段 |
| `ONBOARDING.md` | 必读 / 选读 / 实操三段路线，每条带相对路径 | 脚本核对三段齐全、13 个链接可达 |
| `verify_onboarding.py` | 14 条断言，写 `verify_result.json`，失败非零退出 | 人独立重跑 |
| `reuse_notes.md` | 换仓库要改的 3 个参数与复用顺序 | 脚本核对参数说明 |
| `verify_result.json` | 运行产物：pass/fail/skip 与逐条明细 | 验收证据 |

这里有个设计选择值得强调：**脚本不硬编码 25 个文件名，而是从索引读**。换仓库时只改参数、重标索引，脚本正文不用动。

## 七、全生命周期自动化：一次交付的时间账

![生命周期时间轴：需求 2 分钟、派发 1 分钟、Agent 开发 10 分钟、人工核验 3 分钟、提交与验收 1 分钟](https://imgbed.devzoo.top/images/2026/11/25/05404ba5d63943ed.png)

真正花时间的是 Agent 执行（约 10 分钟）和我在界面上完成的确认动作。把阶段拆开以后，"自动化"不再是一句形容词：**它的边界就是人只在四个节点动手，其余时间由需求卡带着上下文往前走。**

## 八、跨组织协作：人、Agent、同事各自做了什么

我额外在管理端建了一个同事账号"质量复核员"，用于承接交叉复核。

![管理端用户管理：新增质量复核员 qa 账号](https://imgbed.devzoo.top/images/2026/11/25/2d6e7cde98854d4c.png)

又建了一张复核需求，写明"抽查四类文件、确认 PASS 14/14 可复现、留一条复核结论"。

![复核需求入池：把交叉复核也放进同一张需求池](https://imgbed.devzoo.top/images/2026/11/25/6632d08b8adb4fa6.png)

在"安排执行 → 转给同事"里，我看到了一个真实边界：同事尚未启用 SoduWork 时不可接收需求。于是先让同事登录一次桌面端，再回到管理员账号重试。

![转给同事面板：可接收 0 位，未启用 SoduWork 的同事不可接收](https://imgbed.devzoo.top/images/2026/11/25/e61c0e60e21c4d7a.png)

![同事账号登录桌面端：完成一次真实启用](https://imgbed.devzoo.top/images/2026/11/25/bb87ba1368b4405a.png)

![切回管理员账号：为转交与验收保留管理员视角](https://imgbed.devzoo.top/images/2026/11/25/16cf2bb1f640408a.png)

这一节要说清的不是"我建了个账号"，而是三种角色的边界：

| 角色 | 实际做了什么 | 没有做什么 |
|---|---|---|
| 需求方（人） | 选任务、定验收、补派单口径、独立重跑脚本、最终确认 | 没有替 Agent 写四类交付物 |
| 经办 Agent | 勘察材料、建基线、生成四类文件、自跑 14 条断言、回执 | 没有离开 `onboarding/` 改材料 |
| 同事（人） | 建立复核角色、登录启用、承接交叉复核需求 | 没有参与首轮实现 |

`转给同事` 的边界也说明了一件事：**组织协作不是发个链接，而是要有账号、启用状态和权限**。这些都被需求卡记录下来，而不是留在聊天记录里。

## 九、人工确认节点：四个闸门，一个都不能省

Agent 交付后，需求卡进入"待验收"，并提示"核对成果并确认交付"。

![交付后需求进入待验收状态](https://imgbed.devzoo.top/images/2026/11/25/3f6673c71a6c4afc.png)

详情区把验收方式、补充说明、证据入口集中在一处，并明确"由你确认 · 需求创建人"。

![待验收详情：验收方式、证据与确认按钮](https://imgbed.devzoo.top/images/2026/11/25/6ae8d2403b1a4260.png)

我先从"更多"里提交验收，把执行结果交到验收环节。

![提交验收：需求从执行态流转到验收态](https://imgbed.devzoo.top/images/2026/11/25/35f17f6024714066.png)

再选择手动验收，核对标准与证据。

![验收方式：手动验收 / 自动验收，证据可查看](https://imgbed.devzoo.top/images/2026/11/25/fce5a0a0789f4cb7.png)

最后点"确认验收"，系统提示"交付结果已确认"。

![确认验收完成：交付结果已确认](https://imgbed.devzoo.top/images/2026/11/25/755745721ebb4916.png)

四个闸门连起来是：

1. **开工前**：需求方确认验收标准；
2. **执行后**：经办人核对文件清单与 PASS 数；
3. **验收时**：验收方独立重跑脚本、查材料零改动；
4. **沉淀时**：管理员确认版本一致后发布为团队资产。

我做的每一步都发生在闸门上，而不是替 Agent 执行。

## 十、经验沉淀：做完一次，下一次怎么复用

![人机贡献分解：人守标准与确认，Agent 承担可复现的文件产出](https://imgbed.devzoo.top/images/2026/11/25/b431f0645e7c4320.png)

沉淀分三层：

- **SOP**：六步流程、四类交付、四个确认节点、证据留档模板；
- **Skill 包**：触发条件、输入输出、硬约束、执行顺序、复用参数；
- **可复用脚本包**：把整套 `onboarding/` 拷到第二个仓库，改 `SOURCE_ROOT` 一个环境变量，再建一份材料基线。

复用的实际操作只有三步，全部可以写进一条命令：

```powershell
# 1) 整包拷贝到第二仓库
Copy-Item onboarding D:\second-repo\onboarding -Recurse

# 2) 指向第二仓库的材料根（唯一必改项）
$env:SODUWORK_ONBOARD_SOURCE_ROOT = "D:\second-repo"

# 3) 重建第二仓库的材料基线（排除 onboarding 自身），再跑验证
python make_reuse_baseline.py
python onboarding\verify_onboarding.py
```

基线重建脚本的核心就一段：只对材料建哈希，跳过 `onboarding/` 自己，否则脚本会比对自己的产物、永远对不上：

```python
for path in sorted(p for p in source.rglob("*.md") if "onboarding" not in p.parts):
    rel = path.relative_to(source).as_posix()
    files[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
json.dump({"files": files}, open(out, "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)
```

第二仓库的验证结果是 `PASS 14 / 14 (FAIL 0, SKIP 0)`，退出码 0。

![第二仓库复用：14 条断言全部 PASS、退出码 0](https://imgbed.devzoo.top/images/2026/11/25/fc085e8255574864.png)

![双仓库门禁对照：原仓库与第二仓库都是 14/14](https://imgbed.devzoo.top/images/2026/11/25/e9e266661631453d.png)

这就是为什么要把索引做成唯一事实源：脚本不记文件名，只核对"索引与实际材料是否一致"。换仓库时，真正需要人重新判断的只有入线等级，其余是可复用的机制。

## 十一、边界与诚实说明

- Agent 对"必读 / 选读 / 实操"的分类是主观判断，换仓库必须重新标注；脚本只能保证索引与材料一致，不能替人做价值判断。
- 协作转派要求同事已启用 SoduWork；未启用时只能先完成账号启用，这不是 Bug，是组织治理的前置条件。
- 首次启动依赖下载失败靠复用本机运行时解决；换一台全新机器仍需保证网络可达。
- 我没有把"人做了什么"写成一句"人负责验收"就完了：建需求、补口径、建同事账号、独立重跑、提交验收、确认验收、写 SOP，每一步都有截图或文件对应。
- 全程 70 张截图，本文选用 34 张实战截图；量化图的数字来自 `verify_result.json` 与实验时间记录，不是估算。

## 十二、结语

这次实战的结论很简单：**全生命周期自动化不是让人消失，而是让人的判断出现在固定的、可追溯的节点上。**

需求卡带上下文，Agent 做可核对的产出，验证脚本把"做完了"变成"可证明做完了"，SOP 把一次性的做法变成下一次能直接用的资产。人守住四个闸门，其余交给流程。

下次遇到同类任务，我只做三件事：建需求、补口径、在四个节点确认。剩下的，需求池会接着走。

## 相关文档

- [快速开始](../getting-started.md)
- [桌面端快速上手](../desktop-quickstart.md)
- [文档导航](../README.md)
