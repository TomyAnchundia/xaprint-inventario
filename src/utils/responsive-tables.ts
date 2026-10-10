function updateTableLabels(table: HTMLTableElement): void {
  const headers = Array.from(table.querySelectorAll("thead th"), (header) =>
    header.textContent?.trim(),
  );
  table.querySelectorAll<HTMLTableRowElement>("tbody tr").forEach((row) => {
    Array.from(row.cells).forEach((cell, index) => {
      cell.dataset.label =
        cell.colSpan > 1
          ? ""
          : headers[index] ||
            (index === headers.length - 1 ? "Acciones" : `Dato ${index + 1}`);
    });
  });
}

function updateTablesIn(node: Node): void {
  if (!(node instanceof Element)) return;
  const table = node.closest("table");
  if (table) updateTableLabels(table);
  node
    .querySelectorAll<HTMLTableElement>("table")
    .forEach(updateTableLabels);
}

document
  .querySelectorAll<HTMLTableElement>("table")
  .forEach(updateTableLabels);

new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach(updateTablesIn);
  });
}).observe(document.body, { childList: true, subtree: true });
