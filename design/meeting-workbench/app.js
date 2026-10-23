/* Standalone UI concept. All content is synthetic; no microphone or backend connection is used. */
const $ = (selector) => document.querySelector(selector);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const meetings = [
  { id: "product", title: "实时会议助手 · 产品讨论", short: "实时会议助手 · 产品讨论", date: "2026年10月22日", time: "14:30", duration: "24 分钟", category: "PRODUCT MEETING", today: true,
    transcripts: [
      { name: "林然", role: "产品", color: "mint", time: "00:12", text: "今天先聊清楚一件事：这个会议助手，最应该替我们解决什么问题？我觉得不是多记一些文字，而是会议结束后，大家能迅速知道讨论了什么、决定了什么。" },
      { name: "周予", role: "设计", color: "lavender", time: "02:36", text: "我同意。现在所有功能都摆在同一个页面里，信息太满了。我们可以把转写当成主线，纪要和导图随时切换，让人先专注于当下的讨论。", highlight: "把转写当成主线" },
      { name: "陈序", role: "研发", color: "peach", time: "05:48", text: "技术上可以先复用现有能力。录音控制要一直能找到，AI 问答放在侧边，不打断记录。还有一个关键点：每条结论都应该能回到它对应的原话。", highlight: "每条结论都应该能回到它对应的原话", insight: "关键共识 · 结论关联原文" },
      { name: "林然", role: "产品", color: "mint", time: "08:21", text: "那第一版先收敛到三件事：记录、整理、回顾。先把一场会议的完整体验做好。多会议协作和云端同步可以后面再考虑。", highlight: "记录、整理、回顾" },
      { name: "周予", role: "设计", color: "lavender", time: "12:05", text: "我先出一版工作台原型，下周二一起看。重点是让会议内容更好读，操作更安静，不要让界面抢走讨论本身的注意力。" }
    ],
    summary: "先做好一场会议的完整体验：以转写为主线，用纪要提炼结论，用原文支撑回顾。",
    decisionSources: [3, 1, 2], topics: ["首版范围", "信息层次", "原文追溯"],
    decisions: ["首版聚焦记录、整理、回顾，暂缓多人协作与云端同步。", "转写、纪要、导图分开展示，避免多个面板争夺注意力。", "AI 问答放在侧栏；关键结论可以定位到转写原文。"],
    todos: [{ text: "完成会议工作台原型，评审主要布局与信息层次", owner: "周予 · 下周二" }, { text: "确认结论与转写原文关联的实现方案", owner: "陈序 · 待排期" }, { text: "梳理首版范围，整理下一次评审清单", owner: "林然 · 待排期" }]
  },
  { id: "research", title: "每周研究进展同步", short: "每周研究进展同步", date: "2026年10月21日", time: "16:00", duration: "38 分钟", category: "RESEARCH SYNC", today: false,
    transcripts: [
      { name: "林然", role: "研究", color: "mint", time: "00:18", text: "这周先把数据检查和基线结果梳理清楚，每一个结论都要有对应的记录，不能把尚未验证的想法写成已经完成的成果。" },
      { name: "周予", role: "研究", color: "lavender", time: "06:32", text: "我会把汇报改成三部分：已完成的检查、目前观察到的问题、下周需要验证的假设。图表只保留能直接支持判断的几张。", highlight: "已完成的检查、目前观察到的问题、下周需要验证的假设" },
      { name: "陈序", role: "研究", color: "peach", time: "14:10", text: "下一步先补充缺失值的统计，再复核时间划分。检查通过以后，再决定是否开始下一轮实验。", insight: "下一步 · 先完成数据复核" }
    ], summary: "先把数据和结果的依据补齐，再推进下一轮实验。", decisionSources: [1, 2], topics: ["汇报结构", "验证顺序"], decisions: ["汇报区分已完成、待验证和后续计划。", "复核数据缺失情况与时间划分后，再开始下一轮实验。"], todos: [{text:"补充缺失值统计与时间划分复核",owner:"陈序 · 本周"},{text:"更新组会汇报与证据清单",owner:"周予 · 本周"}]
  },
  { id: "review", title: "界面与使用流程评审", short: "界面与使用流程评审", date: "2026年10月20日", time: "10:00", duration: "26 分钟", category: "DESIGN REVIEW", today: false,
    transcripts: [
      { name: "周予", role: "设计", color: "lavender", time: "00:24", text: "用户打开应用时，应该很快知道从哪里开始。首屏保留新建会议与最近会议，模型配置放进设置。" },
      { name: "林然", role: "产品", color: "mint", time: "04:56", text: "对，减少首屏的按钮数量。录音过程中只强调暂停和结束，其他功能按需要展开。", highlight:"减少首屏的按钮数量" },
      { name: "陈序", role: "研发", color: "peach", time: "11:30", text: "还需要设计空白状态、连接失败和权限被拒绝时的提示。不能让用户看到一个空框，却不知道下一步做什么。", insight:"体验细节 · 补齐空白与异常状态" }
    ], summary:"减少首屏操作负担，同时补齐空白状态和异常提示。", decisionSources: [0, 1, 2], topics: ["首屏入口", "录音控制", "异常引导"], decisions:["首屏聚焦新建与最近会议。","录音中突出暂停和结束操作。","补齐空白、连接失败和权限拒绝的引导。"], todos:[{text:"整理主要流程的空白状态与异常提示",owner:"周予 · 本周"},{text:"精简录音工具栏与设置入口",owner:"陈序 · 待排期"}]
  }
];
let current = meetings[0];
let currentView = "transcript";
let mode = "playing";
let elapsed = 24 * 60 + 8;
let toastTimer;
let sending = false;
const checked = new Set();
const chatHistory = new Map();
function toast(message) { clearTimeout(toastTimer); $("#toast").textContent = message; $("#toast").hidden = false; toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 3600); }
function renderMeetings() {
  const search = $("#meeting-search").value.trim().toLowerCase();
  const filtered = meetings.filter((meeting) => meeting.title.toLowerCase().includes(search));
  for (const [selector, today] of [["#today-meetings", true], ["#past-meetings", false]]) {
    $(selector).innerHTML = filtered.filter((meeting) => meeting.today === today).map((meeting) => `<button class="meeting-card ${current?.id === meeting.id ? "active" : ""}" data-meeting="${meeting.id}" ${current?.id === meeting.id ? 'aria-current="true"' : ""}><div class="meeting-card-title">${icon("file")}<span>${escapeHtml(meeting.short)}</span></div><div class="meeting-card-meta"><span>${meeting.today ? meeting.time : meeting.date.slice(5)}</span><span>${meeting.today ? '<span class="live-mini">演示会议</span>' : meeting.duration}</span></div></button>`).join("");
  }
  $("#search-empty").hidden = filtered.length > 0;
}
function renderTranscripts() {
  $("#transcript-count").textContent = String(current?.transcripts.length ?? 0);
  $("#transcript-list").innerHTML = current ? current.transcripts.map((item, index) => {
    let text = escapeHtml(item.text);
    if (item.highlight) text = text.replace(escapeHtml(item.highlight), `<mark>${escapeHtml(item.highlight)}</mark>`);
    return `<article class="transcript-row" id="transcript-${index}"><span class="speaker-avatar ${item.color}">${item.name[0]}</span><div class="transcript-main"><div class="speaker-line"><span class="speaker-name">${item.name}</span><span class="speaker-role">${item.role}</span><button class="timestamp" data-source="${index}" title="定位这段原文">${item.time}</button></div><p>${text}</p>${item.insight ? `<span class="inline-insight">${icon("spark")}${item.insight}</span>` : ""}</div></article>`;
  }).join("") : `<div class="empty-meeting">${icon("wave")}<h2>下一场好讨论，从这里开始</h2><p>这是新建会议的空白状态预览。加载示例，即可体验转写、纪要与 AI 侧栏。</p><button id="load-example">加载示例会议</button></div>`;
}
function renderSummary() {
  $("#content-summary").innerHTML = current ? `<div class="summary-kicker">${icon("spark")}会议内容整理 · 示例</div><h2>把讨论，变成下一步</h2><p class="summary-callout">${escapeHtml(current.summary)}</p><h3>达成的共识</h3><ul>${current.decisions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul><h3>接下来要做的事 <span class="subtle-count">${current.todos.length}</span></h3>${current.todos.map((item,index) => `<label class="todo-item"><input type="checkbox" data-todo="${current.id}-${index}" ${checked.has(`${current.id}-${index}`) ? "checked" : ""}><span>${escapeHtml(item.text)}</span><small class="todo-owner">${escapeHtml(item.owner)}</small></label>`).join("")}<p style="font-size:10px;margin-top:22px">以上为预先编写的示例纪要。实际应用需接入会议整理能力。</p>` : '<div class="empty-meeting"><h2>还没有会议纪要</h2><p>加载示例会议后，可以查看纪要的展示效果。</p></div>';
}
function renderMap() {
  $("#content-map").innerHTML = current ? `<div class="map-topline"><span>围绕讨论，自然生长</span><span>点击分支定位原文 ↗</span></div><div class="map-canvas"><div class="map-root">${escapeHtml(current.short)}<div style="color:var(--muted);font-size:9px;margin-top:6px">讨论结构 · 示例</div></div><div class="map-branches">${current.decisions.slice(0,3).map((item,index) => `<button class="map-node" data-source="${current.decisionSources[index]}"><strong>${current.topics[index]}</strong><span>${escapeHtml(item)}</span><small>原文 ${current.transcripts[current.decisionSources[index]].time} ↗</small></button>`).join("")}</div></div><p class="map-footnote">结论与原文相连，回顾更有依据。</p>` : '<div class="empty-meeting"><h2>想法，还在等待发生</h2><p>加载示例会议后，可以查看讨论结构。</p></div>';
}
function initialChat() {
  return `<div class="assistant-welcome"><div class="assistant-welcome-icon">${icon("spark")}</div><h3>讨论有点多？<br>我帮你找到重点。</h3><p>梳理共识、提取待办，或回顾某个细节。每个要点，都能找到来处。</p></div>${current ? `<div class="assistant-divider">示例对话</div><div class="chat-question">${current.id === "product" ? "帮我梳理一下这次讨论的重点。" : "这次会议有哪些共识？"}</div><div class="chat-answer"><div class="chat-answer-label">${icon("spark")}会议助手</div><p>${escapeHtml(current.summary)}</p><ul>${current.decisions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>${current.transcripts.slice(1,3).map((item,index) => `<button class="citation-button" data-source="${index+1}">${icon("text")}${item.time} 原文 ↗</button>`).join("")}<div class="answer-tools"><button data-copy="initial" aria-label="复制示例回答" title="复制示例回答">${icon("copy")}</button><span>基于示例转写</span></div></div>` : ""}`;
}
function renderChat() { $("#assistant-messages").innerHTML = initialChat() + (chatHistory.get(current?.id ?? "empty") ?? ""); }
function switchView(view) {
  currentView = view;
  for (const button of document.querySelectorAll(".view-tab")) { const selected = button.dataset.view === view; button.classList.toggle("active", selected); button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1; }
  for (const section of document.querySelectorAll(".view-content")) section.hidden = section.id !== `content-${view}`;
}
function updateControls() {
  const playing = mode === "playing" && current?.today;
  $(".app-shell").classList.toggle("paused", !playing);
  $("#recording-label").textContent = !current ? "等待开始" : !current.today ? "历史会议 · 示例" : mode === "ended" ? "演示已结束" : mode === "paused" ? "演示已暂停" : "会议演示中";
  $("#meeting-state").innerHTML = `<i></i>${!current ? "新建预览" : !current.today ? "历史示例" : mode === "ended" ? "已结束" : mode === "paused" ? "已暂停" : "示例演示"}`;
  $("#pause-button").innerHTML = `<span class="${playing ? "pause-glyph" : "play-glyph"}"></span>`;
  $("#pause-button").setAttribute("aria-label", playing ? "暂停演示" : "继续演示");
  $("#pause-button").title = playing ? "暂停演示" : "继续演示";
  $("#pause-button").disabled = !current?.today || mode === "ended";
  $("#end-button").disabled = !current?.today || mode === "ended";
  $("#listening-line").hidden = !current?.today || mode === "ended";
  $("#listening-text").textContent = mode === "paused" ? "已暂停演示，内容保留在这里" : "演示中，想法正在继续…";
  $("#recording-time").textContent = !current ? "00:00" : !current.today ? current.duration.replace(" 分钟", ":00") : `${String(Math.floor(elapsed/60)).padStart(2,"0")}:${String(elapsed%60).padStart(2,"0")}`;
}
function selectMeeting(id) {
  current = meetings.find((item) => item.id === id) ?? null;
  mode = current?.today ? "playing" : "ended";
  $("#meeting-title").textContent = current?.title ?? "未命名会议";
  $("#crumb-title").textContent = current?.id === "product" ? "产品讨论" : current?.short ?? "新建会议";
  $("#meeting-date").textContent = current?.date ?? "新会议 · 交互预览";
  $("#meeting-duration").textContent = current?.duration ?? "尚未开始";
  $(".meeting-category").textContent = current?.category ?? "NEW MEETING";
  $(".attendees").hidden = !current;
  $(".transcript-intro").hidden = !current;
  renderMeetings(); renderTranscripts(); renderSummary(); renderMap(); renderChat(); updateControls(); switchView("transcript");
  $("#content-scroll").scrollTop = 0;
  document.body.classList.remove("sidebar-visible");
}
function locateSource(index) {
  switchView("transcript");
  const row = $(`#transcript-${index}`);
  if (!row) return;
  row.scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",block:"center"});
  row.classList.add("highlight"); setTimeout(() => row.classList.remove("highlight"),1800);
}
function answerFor(question) {
  if (!current) return '<p>当前还没有会议内容。请先加载一场示例会议。</p>';
  if (/待办|下一步|谁|任务/.test(question)) return `<p>这场示例会议整理了 ${current.todos.length} 项后续工作：</p><ul>${current.todos.map((item) => `<li><strong>${escapeHtml(item.text)}</strong><br>${escapeHtml(item.owner)}</li>`).join("")}</ul>`;
  if (/共识|结论|决定|重点|总结|梳理/.test(question)) return `<p>${escapeHtml(current.summary)}</p><ul>${current.decisions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  return `<p>这是界面交互预览，目前只提供预设回复，没有接入真实 AI。你可以试试“整理共识”或“提取待办”，也可以点击下方来源回到示例原文。</p>`;
}
function ask(question) {
  const text = question.trim(); if (!text || sending) return;
  if (!current) { toast("先加载示例会议，再体验问答。"); return; }
  const key = current.id;
  const previous = chatHistory.get(key) ?? "";
  const questionHtml = `<div class="chat-question">${escapeHtml(text)}</div>`;
  chatHistory.set(key, previous + questionHtml);
  $("#question-input").value = "";
  $("#send-button").disabled = true;
  sending = true;
  renderChat(); $("#assistant-messages").scrollTop = $("#assistant-messages").scrollHeight;
  setTimeout(() => {
    const meeting = meetings.find((item) => item.id === key);
    const source = /待办|下一步|谁|任务/.test(text) ? meeting.transcripts.length - 1 : meeting.decisionSources[0];
    // Selection can change during the small UI delay; answer using its original meeting.
    const selected = current; current = meeting;
    const answerHtml = `<div class="chat-answer"><div class="chat-answer-label">${icon("spark")}会议助手<span class="demo-chip">预设回复</span></div>${answerFor(text)}<button class="citation-button" data-source="${source}">${icon("text")}${meeting.transcripts[source].time} 原文 ↗</button></div>`;
    current = selected;
    chatHistory.set(key, previous + questionHtml + answerHtml);
    sending = false;
    if (current?.id === key) { renderChat(); $("#assistant-messages").scrollTop = $("#assistant-messages").scrollHeight; }
    $("#send-button").disabled = !$("#question-input").value.trim();
  },450);
}
function toggleAssistant() {
  if (innerWidth <= 760) document.body.classList.toggle("assistant-visible");
  else document.body.classList.toggle("assistant-hidden");
}
function toggleSidebar() {
  if (innerWidth <= 1020) document.body.classList.toggle("sidebar-visible");
  else document.body.classList.toggle("sidebar-hidden");
}
function toggleTheme() { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; }
$("#meeting-search").addEventListener("input",renderMeetings);
$("#theme-toggle").addEventListener("click",toggleTheme);
$("#dialog-theme").addEventListener("click",toggleTheme);
$("#sidebar-toggle").addEventListener("click",toggleSidebar);
$("#assistant-toggle").addEventListener("click",toggleAssistant);
$("#assistant-close").addEventListener("click",toggleAssistant);
$("#dialog-assistant").addEventListener("click",toggleAssistant);
$("#settings-button").addEventListener("click",() => $("#settings-dialog").showModal());
$("#workspace-info").addEventListener("click",() => $("#settings-dialog").showModal());
$("#history-button").addEventListener("click",() => { if (innerWidth <= 1020) document.body.classList.add("sidebar-visible"); else document.body.classList.remove("sidebar-hidden"); $("#meeting-search").focus(); });
$("#home-button").addEventListener("click",() => selectMeeting("product"));
$("#new-meeting").addEventListener("click",() => { selectMeeting(null); toast("已进入新建会议预览；此原型不会启动录音。"); });
$("#pause-button").addEventListener("click",() => { mode = mode === "playing" ? "paused" : "playing"; updateControls(); });
$("#end-button").addEventListener("click",() => { mode = "ended"; updateControls(); switchView("summary"); toast("演示已结束，可以查看示例纪要。点击左侧会议可重新体验。"); });
$("#jump-latest").addEventListener("click",() => $("#listening-line").scrollIntoView({behavior:"smooth",block:"end"}));
$("#question-input").addEventListener("input",() => { $("#send-button").disabled = sending || !$("#question-input").value.trim(); });
$("#question-input").addEventListener("keydown",(event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); ask(event.currentTarget.value); } });
$("#ask-form").addEventListener("submit",(event) => { event.preventDefault(); ask($("#question-input").value); });
$("#export-button").addEventListener("click",() => {
  if (!current) { toast("当前没有内容可导出，请先加载示例。"); return; }
  const text = `# ${current.title}\n\n> 界面预览导出，以下均为示例内容。\n\n${current.date}\n\n## 会议纪要\n\n${current.summary}\n\n${current.decisions.map((item) => `- ${item}`).join("\n")}\n\n## 待办事项\n\n${current.todos.map((item,index) => `- [${checked.has(`${current.id}-${index}`) ? "x" : " "}] ${item.text}（${item.owner}）`).join("\n")}\n\n## 转写原文\n\n${current.transcripts.map((item) => `**${item.time} · ${item.name}**\n\n${item.text}`).join("\n\n")}\n`;
  const url = URL.createObjectURL(new Blob(["\uFEFF",text],{type:"text/markdown;charset=utf-8"}));
  const link = document.createElement("a"); link.href = url; link.download = `${current.short}-示例.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url),2000); toast("已导出这场会议的示例纪要与转写。");
});
document.addEventListener("click",async(event) => {
  const tab = event.target.closest("[data-view]"); if (tab) switchView(tab.dataset.view);
  const meeting = event.target.closest("[data-meeting]"); if (meeting) selectMeeting(meeting.dataset.meeting);
  const source = event.target.closest("[data-source]"); if (source) locateSource(Number(source.dataset.source));
  const suggestion = event.target.closest("[data-question]"); if (suggestion) ask(suggestion.dataset.question);
  if (event.target.closest("#load-example")) selectMeeting("product");
  if (event.target.closest("[data-copy]")) {
    try { await navigator.clipboard.writeText(`${current.summary}\n${current.decisions.map((item) => `- ${item}`).join("\n")}`); toast("示例回答已复制。"); }
    catch { toast("复制不可用；可以选择文字后复制，或使用导出。"); }
  }
});
document.addEventListener("change",(event) => { const key = event.target.dataset.todo; if (key) { if (event.target.checked) checked.add(key); else checked.delete(key); } });
$(".view-tabs").addEventListener("keydown",(event) => { if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return; event.preventDefault(); const views = ["transcript","summary","map"]; let index = views.indexOf(currentView); index = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : 2))%3; switchView(views[index]); $(`#tab-${views[index]}`).focus(); });
document.addEventListener("keydown",(event) => { if (event.key === "/" && !["INPUT","TEXTAREA"].includes(document.activeElement.tagName) && !$("#settings-dialog").open) { event.preventDefault(); if (innerWidth <= 1020) document.body.classList.add("sidebar-visible"); else document.body.classList.remove("sidebar-hidden"); $("#meeting-search").focus(); } });
$("#audio-wave").innerHTML = Array.from({length:30},(_,index) => `<i style="height:${[5,9,14,7,18,24,11,16,8,22,29,14,19,7,12][index%15]}px;animation-delay:${index*.07}s"></i>`).join("");
setInterval(() => { if (mode === "playing" && current?.today) { elapsed++; updateControls(); } },1000);
selectMeeting("product");
