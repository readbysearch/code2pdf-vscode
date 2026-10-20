// The PDF tab's page (see src/viewer.ts): pdf.js's viewer, with a toolbar. The extension sends
// the PDF's bytes ("load"), and again when the file changes; the page and zoom stay as they
// were, then and when the tab comes back after being hidden (the webview's saved state).

const vscode = globalThis.vscode;  // acquired by the page's first script (src/viewer.ts)
const config = JSON.parse(document.getElementById("config").textContent);
const $ = (id) => document.getElementById(id);
const state = vscode.getState() ?? {};

let pdfjsLib;
let viewer;
let linkService;
let pdf;
/** The page and zoom to go back to once a new copy of the PDF is laid out. */
let restore = { page: state.page, scale: state.scale };
let reportRendered = true;

function save(change) {
  Object.assign(state, change);
  vscode.setState(state);
}

function say(text) {
  $("message").textContent = text;
  $("message").hidden = !text;
}

function failed(what, error) {
  const message = error instanceof Error ? error.message : String(error);
  say(`${what}: ${message}`);
  vscode.postMessage({ type: "failed", message: `${what}: ${message}` });
}

function showScale(value, scale) {
  const select = $("scale");
  const option = [...select.options].find((o) => o.value === String(value));
  if (option && option.value !== "custom") {
    select.value = option.value;
  } else {
    const custom = select.querySelector('option[value="custom"]');
    custom.textContent = `${Math.round(scale * 100)}%`;
    select.value = "custom";
  }
}

async function load(bytes) {
  try {
    const next = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
    const old = pdf;
    pdf = next;
    if (old) {
      restore = { page: viewer.currentPageNumber, scale: viewer.currentScaleValue };
    }
    reportRendered = true;
    viewer.setDocument(next);
    linkService.setDocument(next, null);
    say("");
    await old?.destroy();
  } catch (error) {
    failed("This PDF can't be shown", error);
  }
}

async function start() {
  pdfjsLib = await import(config.pdfjs);
  globalThis.pdfjsLib = pdfjsLib;  // pdf_viewer.mjs finds it there
  const source = await (await fetch(config.worker)).text();
  const worker = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(worker, { type: "module" });
  const { EventBus, LinkTarget, PDFLinkService, PDFViewer } = await import(config.viewer);

  const eventBus = new EventBus();
  linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
  viewer = new PDFViewer({ container: $("viewerContainer"), viewer: $("viewer"), eventBus, linkService });
  linkService.setViewer(viewer);

  eventBus.on("pagesinit", () => {
    viewer.currentScaleValue = restore.scale ?? "page-width";
    if (restore.page && restore.page <= viewer.pagesCount) {
      viewer.currentPageNumber = restore.page;
    }
    $("count").textContent = ` of ${viewer.pagesCount.toLocaleString("en-US")}`;
    $("page").max = String(viewer.pagesCount);
  });
  eventBus.on("pagechanging", ({ pageNumber }) => {
    $("page").value = String(pageNumber);
    save({ page: pageNumber });
  });
  eventBus.on("scalechanging", ({ scale, presetValue }) => {
    showScale(presetValue ?? scale, scale);
    save({ scale: presetValue ?? String(scale) });
  });
  eventBus.on("pagerendered", () => {
    if (reportRendered) {
      reportRendered = false;
      vscode.postMessage({ type: "rendered", pages: viewer.pagesCount });
    }
  });

  $("previous").addEventListener("click", () => viewer.previousPage());
  $("next").addEventListener("click", () => viewer.nextPage());
  $("page").addEventListener("change", () => {
    const page = Math.min(Math.max(1, Math.round(Number($("page").value)) || 1), viewer.pagesCount || 1);
    viewer.currentPageNumber = page;
    $("page").value = String(page);
  });
  $("zoomIn").addEventListener("click", () => viewer.increaseScale());
  $("zoomOut").addEventListener("click", () => viewer.decreaseScale());
  $("scale").addEventListener("change", () => {
    if ($("scale").value !== "custom") {
      viewer.currentScaleValue = $("scale").value;
    }
  });
  for (const id of ["external", "reveal", "copyPath"]) {
    $(id)?.addEventListener("click", () => vscode.postMessage({ type: id }));
  }
  // Keep "Page Width" fitting when the tab is resized
  new ResizeObserver(() => {
    const value = viewer.currentScaleValue;
    if (value === "page-width" || value === "page-fit") {
      viewer.currentScaleValue = value;
    }
  }).observe($("viewerContainer"));

  window.addEventListener("message", (event) => {
    if (event.data?.type === "load") {
      void load(event.data.bytes);
    } else if (event.data?.type === "error") {
      say(event.data.message);
    }
  });
  vscode.postMessage({ type: "ready" });
}

start().catch((error) => failed("The PDF viewer couldn't start", error));
