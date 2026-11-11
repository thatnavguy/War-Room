'use strict';

let mermaidModule;
let diagramSequence = 0;

async function loadMermaid() {
  if (!mermaidModule) {
    mermaidModule = import('/vendor/mermaid/mermaid.esm.min.mjs').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        htmlLabels: false,
        maxTextSize: 50000,
        maxEdges: 500,
        secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering', 'maxTextSize', 'maxEdges', 'htmlLabels'],
        theme: 'base',
        fontFamily: '"Segoe UI", "Helvetica Neue", Arial, sans-serif',
        themeVariables: {
          primaryColor: '#e7edf1',
          primaryTextColor: '#162636',
          primaryBorderColor: '#60707f',
          lineColor: '#1d5274',
          secondaryColor: '#ffffff',
          tertiaryColor: '#f4f6f7',
        },
        flowchart: { htmlLabels: false },
      });
      return mermaid;
    });
  }
  return mermaidModule;
}

function diagramError(figure, error) {
  const status = figure.querySelector('.diagram-status');
  status.hidden = false;
  status.textContent = `Diagram could not be rendered. ${String(error?.message || error || 'Unknown diagram error.').slice(0, 400)}`;
  status.classList.add('diagram-error');
  figure.querySelector('.diagram-source').open = true;
}

function updateDiagramHint(figure) {
  const output = figure.querySelector('.diagram-output');
  figure.querySelector('.diagram-hint').hidden = output.hidden ||
    (output.scrollWidth <= output.clientWidth && output.scrollHeight <= output.clientHeight);
}

async function renderDiagrams(root, isCurrent = () => true) {
  const figures = [...root.querySelectorAll('figure.wiki-diagram')];
  if (!figures.length) return;
  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    if (isCurrent()) {
      for (const figure of figures) diagramError(figure, new Error('The local Mermaid renderer did not load. Reload Reading Room to try again.'));
    }
    return;
  }
  for (const figure of figures) {
    if (!isCurrent()) return;
    try {
      const source = figure.querySelector('.language-mermaid').textContent;
      if (source.length > 50000) throw new Error('This diagram exceeds the 50,000-character limit.');
      const { svg } = await mermaid.render(`reading-diagram-${++diagramSequence}`, source);
      if (!isCurrent()) return;
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      if (parsed.querySelector('parsererror')) throw new Error('Mermaid returned an invalid image.');
      const image = document.createElement('img');
      const title = parsed.querySelector('title')?.textContent;
      const description = parsed.querySelector('desc')?.textContent;
      image.alt = [title, description].filter(Boolean).join('. ') || 'Mermaid diagram. Expand Diagram source for its text.';
      // SVG images cannot run scripts or load external resources, unlike inline SVG.
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      const bounds = parsed.documentElement.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
      if (bounds?.length === 4 && bounds.every(Number.isFinite) && bounds[2] > 0 && bounds[3] > 0) {
        image.width = Math.ceil(bounds[2]);
        image.height = Math.ceil(bounds[3]);
      }
      await image.decode();
      if (!isCurrent()) return;
      const output = figure.querySelector('.diagram-output');
      output.replaceChildren(image);
      output.hidden = false;
      updateDiagramHint(figure);
      figure.querySelector('.diagram-status').hidden = true;
    } catch (error) {
      if (isCurrent()) diagramError(figure, error);
    }
  }
}

window.ReadingDiagrams = { render: renderDiagrams };
window.addEventListener('resize', () => {
  for (const figure of document.querySelectorAll('figure.wiki-diagram')) updateDiagramHint(figure);
});
