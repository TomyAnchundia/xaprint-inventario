export interface PosSearchCandidate {
  productName: string;
  category: string;
  productSku: string;
  productBarcode: string;
  variantSize: string;
  variantColor: string | null;
  variantSku: string;
  variantBarcode: string;
  legacyBarcode?: string;
}

export interface PosSearchQuery {
  terms: string[];
  sizes: string[];
  colors: string[];
}

const SIZE_LABELS = new Set(["talla", "size"]);
const COLOR_LABELS = new Set(["color", "colour"]);

export function normalizePosSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es");
}

export function parsePosSearch(query: string): PosSearchQuery {
  const tokens = normalizePosSearchText(query)
    .replace(/[,:;=]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const parsed: PosSearchQuery = { terms: [], sizes: [], colors: [] };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (
      SIZE_LABELS.has(token) &&
      next &&
      !SIZE_LABELS.has(next) &&
      !COLOR_LABELS.has(next)
    ) {
      parsed.sizes.push(next);
      index += 1;
    } else if (
      COLOR_LABELS.has(token) &&
      next &&
      !SIZE_LABELS.has(next) &&
      !COLOR_LABELS.has(next)
    ) {
      parsed.colors.push(next);
      index += 1;
    } else {
      parsed.terms.push(token);
    }
  }

  return parsed;
}

export function matchesPosSearch(
  candidate: PosSearchCandidate,
  query: PosSearchQuery,
): boolean {
  const searchableText = normalizePosSearchText(
    [
      candidate.productName,
      candidate.category,
      candidate.productSku,
      candidate.productBarcode,
      candidate.variantSize,
      candidate.variantColor ?? "",
      candidate.variantSku,
      candidate.variantBarcode,
      candidate.legacyBarcode ?? "",
    ].join(" "),
  );

  return (
    query.terms.every((term) => searchableText.includes(term)) &&
    query.sizes.every(
      (size) => normalizePosSearchText(candidate.variantSize) === size,
    ) &&
    query.colors.every((color) =>
      normalizePosSearchText(candidate.variantColor ?? "").includes(color),
    )
  );
}
