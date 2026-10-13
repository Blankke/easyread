/*
 * 用法：由 chatgpt-web.cjs 在已登录的 ChatGPT 页面调用 projectPage(action, value)。
 * 项目操作只点击网页可见控件；任何一步无法核实都会报错，避免把论文发到普通会话。
 */
const PROJECT_NAME = "翻译";
// 这是 ChatGPT 项目指令的唯一权威版本；修改正文时递增版本号，桌面版会按内容哈希重新同步。
// 具体 JSON 结构、句子对齐和目标语言由每轮任务指定，此处只保留跨任务稳定的规则。
const INSTRUCTIONS = `【EasyRead 通用指令·版本 2】
你协助读者通过 EasyRead 阅读、翻译和核对学术论文。优先保证原文忠实、术语一致、便于核对和输出可被软件解析。本轮明确指定的任务、目标语言、页码、术语表、回答方式及输出格式优先于以下默认规则；未指定语言时使用简体中文。

每次只处理当前对话提供的论文及本轮相关材料。不同论文之间不得混用事实、公式、实验结果、术语表或阅读笔记。先前对话可以帮助理解读者的问题，不能作为当前论文内容的证据。读者的标记和笔记表达读者的关注或判断，不自动代表作者观点。

翻译时只翻译本轮指定的范围。相邻页面、前文译文和摘要可用于理解上下文，不因此扩大输出范围。有原始 PDF 且能够读取时，用它核对页码、阅读顺序、公式和图表；有原页图时，用图核对版面。文字提取结果仅作辅助。双栏、跨页续句、脚注和浮动图表按实际阅读顺序处理，避免遗漏、重复或拼接不相邻的内容。无法读取或辨认的部分不要猜测，也不要声称已经核对。

译文完整保留原文的信息、论证顺序、条件、限定词、否定、比较对象、数值、单位、公式、引用和语气强度。区分事实、假设、推断、观察与作者解释；不把“可能”写成“确定”，不把相关性写成因果性。在语义等价的前提下使用自然、准确的目标语言学术表达，可调整语序，但不以摘要、导读或补充推理代替原文。翻译字段只放对应译文；原文疑点与核对意见仅在本轮允许的独立字段中填写，正文照原文翻译。

遵守本轮术语表。同一篇论文中的同一概念保持译名一致，原文中不同的概念不要随意合并。目标语言为中文且有助于理解时，重要术语首次出现可写作“中文译名（原文术语）”；后续使用约定译名或缩写。模型、数据集、变量、代码标识符等保留准确写法。代码、命令、路径和程序字符不得因翻译而改变。

保持标题层级、段落、列表、定理、证明、图表、题注与引用关系。保留表格行列、数字和单位；图中文字只处理能够辨认的内容。参考文献条目默认保留原文。数学符号、上下标、公式编号及条件必须准确。普通正文使用 EasyRead 可渲染的 KaTeX 写法：行内公式用 $...$，独立公式用单独一行的 $$...$$；原生 math 块的 tex 字段只放公式主体，编号按本轮字段要求填写。

输出格式严格服从本轮请求。需要 JSON 时，只返回一个合法 JSON 对象，不加代码围栏或说明；字段名、数据类型、块 ID、页码及原译文对应关系均按本轮约定，不自行添加字段或块类型。正确转义字符串中的引号、换行和 TeX 反斜杠。只有本轮要求句子对齐时才插入 ‖，并遵守该轮指定的位置和数量规则；不要把它放进公式、代码或不支持的字段。普通问答直接回答，不套用翻译 JSON 格式。

读者提问时，先回答问题，再给出相关依据和必要解释。区分论文明确陈述、依据论文作出的推导，以及帮助理解的补充知识；补充知识不得冒充论文结论。涉及论文事实时，尽量给出可核对的章节、PDF 页码、公式或图表编号，不向读者展示 EasyRead 内部块 ID。解释机制时按需说明输入、输出、关键操作、变量含义和约束；解释实验时交代实际相关的模型、数据、基线、指标及条件。材料不足或论文未报告的结果应明确说明。

输出前核对范围是否完整，数值、限定词、否定、术语、公式及引用是否准确，格式是否符合本轮要求。只输出最终结果，不展示核查过程。
【EasyRead 通用指令结束】`;

// 该函数会序列化后在网页执行；不读取网页私有接口，也不暴露本地桥凭据。
function projectPage(action, value = "") {
  try {
  const visible = el => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
    // 窄侧栏或收起的 WebContentsView 会让项目行宽度为 0，仍可按精确标签调用。
    return !el.closest('[aria-hidden="true"]') && getComputedStyle(el).display !== "none";
  };
  const label = el => (el.getAttribute("aria-label") || el.innerText || el.textContent || "").trim();
  const controls = root => [...root.querySelectorAll('button,[role="button"],[role="menuitem"]')].filter(visible);
  const find = (root, re) => controls(root).find(el => re.test(label(el)));
  const projectLinks = () => [...document.querySelectorAll('a[href*="/g/g-p-"],a[href*="/project/"]')]
    .filter(el => new URL(el.href).origin === location.origin);
  const projectLink = projectLinks().find(el => (el.innerText || el.textContent || "")
    .split("\n").some(line => line.trim() === value));
  // 新版 ChatGPT 侧栏把项目 ID 和名称放在行属性中；取页面已有 ID 构造项目地址。
  const taggedRow = [...document.querySelectorAll('[data-app-action-sidebar-project-id]')]
    .find(el => el.getAttribute('data-app-action-sidebar-project-label') === value);
  const projectId = taggedRow?.getAttribute('data-app-action-sidebar-project-id');
  const taggedURL = /^g-p-[\w-]+$/.test(projectId || "")
    ? `${location.origin}/g/${projectId}/project` : "";
  const directoryRow = [...document.querySelectorAll('[data-project-row]')].find(row =>
    [...row.querySelectorAll('span')].some(el => !el.children.length &&
      (el.innerText || el.textContent || "").trim() === value));
  // 旧版侧栏没有行属性时，可通过项目操作按钮定位同一行。
  const projectMenu = [...document.querySelectorAll('button[aria-label]')]
    .find(el => label(el) === `${value} 的项目操作` || label(el) === `${value} project options`);
  const projectRow = taggedRow || projectMenu?.closest('[role="button"]');
  const dialog = () => [...document.querySelectorAll('[role="dialog"],dialog')].find(visible);
  const editor = () => {
    const root = dialog() || document.querySelector('main') || document;
    return [...root.querySelectorAll('textarea,[contenteditable="true"]')]
      .find(el => visible(el) && !el.closest('[data-testid="composer-root"]') &&
        !el.matches('[data-testid="prompt-textarea"],#prompt-textarea'));
  };
  if (action === "sidebar-ready") return !!find(document,
    /^(new project|create project|新建项目|创建项目|添加新项目|add new project)$/i);
  if (action === "directory-ready") return !!document.querySelector('[data-projects-rows]');
  if (action === "directory-count") return document.querySelectorAll('[data-project-row]').length;
  if (action === "find") return projectLink ? { url: projectLink.href } : taggedURL ? { url: taggedURL } :
    directoryRow || projectRow ? { present: true } : null;
  if (action === "open-existing") {
    if (projectLink) projectLink.click();
    else if (directoryRow) {
      const open = [...directoryRow.querySelectorAll('button')].find(el =>
        /^(在项目中开始新聊天|start new chat in project)$/i.test(label(el)));
      if (!open) throw new Error(`项目目录中找不到“${value}”的打开入口`);
      open.click();
    }
    else if (projectRow) projectRow.click();
    else throw new Error(`找不到 ChatGPT 项目：${value}`);
    return true;
  }
  if (action === "open-create") {
    const button = find(document, /^(new project|create project|新建项目|创建项目|添加新项目|add new project)$/i);
    if (!button) throw new Error("找不到 ChatGPT 新建项目入口，请展开左侧项目栏");
    button.click();
    return true;
  }
  if (action === "fill-create") {
    const root = dialog();
    const input = root?.querySelector('input[type="text"],input:not([type])');
    if (!input) throw new Error("找不到 ChatGPT 项目名称输入框");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // 新项目选择仅项目记忆，隔离个人其他对话；无此选项时由网页默认值决定。
    const only = find(root, /project.only memory|仅项目记忆|只限项目|项目专属记忆/i);
    if (only) only.click();
    return input.value === value;
  }
  if (action === "submit-create") {
    const root = dialog();
    const button = root && find(root, /^(create|创建|新建)( project|项目)?$/i);
    if (!button || button.disabled) throw new Error("ChatGPT 项目创建按钮不可用");
    button.click();
    return true;
  }
  if (action === "open-settings-menu") {
    const heading = [...document.querySelectorAll('main h1,main h2')]
      .find(el => (el.innerText || el.textContent || "").trim() === value);
    if (!heading) throw new Error(`网页未确认位于“${value}”项目`);
    const main = heading.closest('main') || document.querySelector('main');
    const buttons = controls(main);
    const button = buttons.find(el => /more options|project options|项目操作|更多选项|项目选项|更多/i.test(
      [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid')].filter(Boolean).join(' '))) ||
      buttons.find(el => /^(···|•••|…)$/.test(label(el)));
    if (!button) throw new Error("找不到 ChatGPT 项目菜单");
    // Radix 菜单在 pointerdown 打开；单独调用 click 不会触发菜单。
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
    button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", button: 0 }));
    return true;
  }
  if (action === "open-settings") {
    const item = find(document, /^(project settings|项目设置|项目设定)$/i);
    if (!item) throw new Error("找不到 ChatGPT 项目设置入口");
    item.click();
    return true;
  }
  if (action === "read-instructions") {
    const box = editor();
    if (!box) {
      const add = find(dialog() || document.querySelector('main') || document,
        /^(add instructions|添加指令|添加项目指令)$/i);
      if (add) { add.click(); return { opened: false }; }
      throw new Error("找不到 ChatGPT 项目指令输入框");
    }
    return { opened: true, text: box.value ?? box.innerText ?? "" };
  }
  if (action === "focus-instructions") {
    const box = editor();
    if (!box) throw new Error("找不到 ChatGPT 项目指令输入框");
    box.focus();
    if (box instanceof HTMLTextAreaElement) box.select();
    else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(box);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return true;
  }
  if (action === "read-memory") {
    const root = dialog();
    const button = root && find(root, /^(默认|default|仅限项目|仅项目记忆|project.only|project only)$/i);
    if (!button) throw new Error("找不到 ChatGPT 项目记忆设置");
    return { text: label(button) };
  }
  if (action === "open-memory") {
    const root = dialog();
    const button = root && find(root, /^(默认|default|仅限项目|仅项目记忆|project.only|project only)$/i);
    if (!button) throw new Error("找不到 ChatGPT 项目记忆设置");
    if (button.getAttribute("aria-expanded") !== "true") {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
      button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse", button: 0 }));
    }
    return true;
  }
  if (action === "select-project-memory") {
    const menu = [...document.querySelectorAll('[role="menu"]')].find(visible);
    const option = [...(menu?.querySelectorAll('[role="menuitemradio"]') || [])]
      .find(el => /^(仅限项目|仅项目记忆|project.only|project only)/i.test(label(el)));
    if (!option) return false;
    if (option.getAttribute("aria-disabled") === "true") return false;
    option.click();
    return true;
  }
  if (action === "save-instructions") {
    const root = dialog() || document.querySelector('main') || document;
    const button = find(root, /^(save|保存|save changes|保存更改|完成|done)$/i);
    if (!button || button.disabled) throw new Error("ChatGPT 项目指令保存按钮不可用");
    button.click();
    return true;
  }
  throw new Error(`未知项目操作：${action}`);
  } catch (error) {
    // Electron 会把页面异常折叠为通用错误；把控件定位原因带回主进程。
    return { error: error.message };
  }
}

function mergeInstructions(existing) {
  const old = String(existing || "");
  // 同时识别历史的“·v2”和正式的“·版本 2”，清掉曾手工粘贴造成的多个 EasyRead 段落。
  const marker = /【EasyRead 通用指令·(?:版本\s*\d+|v\d+)】[\s\S]*?【EasyRead 通用指令结束】/gu;
  const matches = [...old.matchAll(marker)];
  if (matches.length === 1 && matches[0][0] === INSTRUCTIONS) return old;
  // 只收紧被删除段落两侧的空行，保留用户自己写的规则和内部排版。
  const personal = old.split(marker).map(section => section.trim()).filter(Boolean).join("\n\n");
  return [personal, INSTRUCTIONS].filter(Boolean).join("\n\n");
}

module.exports = { PROJECT_NAME, INSTRUCTIONS, projectPage, mergeInstructions };
