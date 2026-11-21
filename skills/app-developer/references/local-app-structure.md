# 简单本地即用的页面与组件组织

适用于无需独立后端的简单本地即用，默认采用 HTML/CSS/原生 JavaScript，资源随包离线运行。Web 服务与 H5 接入的技术栈不限制，可采用 Vue、React 等；已有工程尊重其技术栈，不为套用本地结构重写。

## 先划职责，再写页面

- 入口 HTML 只放应用外壳、导航、容器和资源引用；业务页面分别维护，公共组件独立复用。
- 页面负责业务视图和交互；公共组件负责列表、对话框等重复界面；数据访问模块封装同源 SDK 调用。小应用按实际需要创建文件，不为单个按钮生成整套框架。
- 单个手写 HTML/JS 保持短小，通常以300～500行为目标；800行是评审提醒。增长时先检查职责和依赖，按清晰的页面、组件、数据访问边界拆分。不要把整个应用塞进一个 HTML 或 app.js，也不要靠压缩排版、机械切片或无意义文件层级凑行数。第三方/生成文件单独评审。

一种可按需采用的目录：

```text
ui/
  index.html           # 外壳与页面容器
  app.js               # 导航、挂载与清理
  app.css              # 主题与布局
  pages/notes.js       # 便签页面
  pages/settings.js    # 本应用的业务偏好页面（按需）
  components/notice.js # 多页面共用组件（按需）
  data/notes.js        # 宿主数据读写
  soduwork-app.js      # 随包同源 SDK
```

## 分开维护，直接嵌入

内部页面、页签、抽屉和弹窗复用内容时，直接在父页面的 div 容器挂载 DOM，无需通过 iframe 创建另一份文档。页面模块可约定 `mount(container, context)` 返回清理函数，或提供配对 `unmount`；公共组件用同样的简单接口即可，无需自建复杂框架。

```js
// pages/notes.js（ES module 示例）
export function mount(container, context) {
  const lifetime = new AbortController();
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = context.copy.refresh;
  button.addEventListener('click', context.refresh, { signal: lifetime.signal });
  container.replaceChildren(button);
  return () => {
    lifetime.abort();
    container.replaceChildren();
  };
}
```

```js
// app.js（由 index.html 通过 type="module" 加载）
import { mount as mountNotes } from './pages/notes.js';
const host = document.getElementById('pageHost'); // index.html 中的 div
let dispose;
function showNotes(context) {
  dispose?.();
  dispose = mountNotes(host, context);
}
```

页面可在自己的 JS 内生成少量 DOM，也可使用独立模板/HTML片段。若加载片段，只加载受信任随包相对资源，显式绑定行为；不要把整份 HTML 的 head/body/script 直接塞进 innerHTML 或执行业务数据里的脚本。需要独立入口时加薄 HTML 外壳，仍复用相同页面模块。

ES modules 优先隔离作用域；若用普通 script，采用闭包/明确命名空间并核对加载顺序，防止顶层声明冲突。查询限定当前容器，避免重复 ID；CSS 使用页面/组件前缀，主题沿用应用令牌。所有模块、模板与样式都纳入 resources，使用相对路径，不依赖 CDN。

## 数据写入的读回与并发约定

简单本地即用同样承载真实业务数据，写入不能"调用即成功"。本节约定写入可靠性，
适用于直接使用宿主 SQLite（见 host-data-sdk.md）的数据访问模块。

- **写后读回，核对生效**：写入成功后重新读取同一记录或计数并与期望比对，
  一致才算完成；不一致按失败处理并保留原因，让用户可重试，不要静默吞掉。
- **revision 防覆盖**：更新已有记录时携带刚读到的 revision（CAS 语义）；
  遇到版本冲突先重新读取再决定，避免多页面/多窗口同时操作互相覆盖。
- **失败不回落**：数据访问失败时保留失败原因并向上返回，
  不要静默改用 localStorage/IndexedDB 等其他存储，以免同一业务的数据分裂到两处。
  浏览器存储只用于可丢弃的界面状态。
- **一次操作一个 requestId**：可能触发 AI 或多步业务的动作创建稳定 requestId，
  重试沿用同一编号；提交期间禁用重复入口，回执未知时先核对实际结果，
  不要盲目重试造成重复扣费或重复记录。

这些约定与 host-data-sdk.md 的数据声明、development-workflow.md 第 5 节
"业务读回"和第 6 节的交付分列一致。验收时至少覆盖：写后读回、CAS 冲突、
失败路径与小屏/切页后的数据保持；只通过语法或静态检查不能替代这些验证。

切换时解除事件、订阅、定时器并中止请求或用版本号丢弃旧响应；跨页面保留的草稿放应用状态或按需存入宿主数据，避免卸载丢失或旧清理误删新页面。验收来回切换、嵌入复用、焦点、滚动、草稿恢复和迟到响应，不只检查语法。

iframe 留给确需独立文档/安全隔离的场景，例如外部服务或不受信任内容；不作为简单本地即用内部页面组合的默认方式。确需使用时遵循既有 SDK 来源校验与权限规则，不绕过隔离。
