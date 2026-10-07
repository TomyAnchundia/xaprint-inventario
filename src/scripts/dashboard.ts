import JsBarcode from "jsbarcode";
import { jsPDF } from "jspdf";
import { io, type Socket } from "socket.io-client";
import {
  clearInventoryToken,
  getInventoryToken,
  inventoryRequest,
  loginInventory,
  type InventoryUser,
} from "../services/api";

interface Product {
  id: number;
  name: string;
  sku: string;
  barcode: string;
  categoryId: number;
  category: string;
  price: number;
  unitsPerBox: number | null;
  boxPrice: number | null;
  stock: number;
  minStock: number;
  variants: ProductVariant[];
  tone: string;
  initials: string;
}

interface ProductVariant {
  id: number;
  tallaId: number;
  colorId: number | null;
  size: string;
  color: string | null;
  sku: string;
  barcode: string;
  legacyBarcode?: string;
  stock: number;
  minStock: number;
  price?: number;
}

interface Movement {
  id: number;
  productId: number;
  variantId: number;
  size: string;
  type: "Ingreso" | "Salida" | "Venta";
  quantity: number;
  date: Date;
  user: string;
  productName?: string;
}

interface SaleLine {
  productId: number;
  variantId: number;
  size: string;
  name: string;
  presentation: "UNIDAD" | "CAJA";
  unitsPerPresentation: number;
  quantity: number;
  price: number;
}

interface Sale {
  id: string;
  date: Date;
  customerId: number;
  customerName: string;
  customerPhone?: string;
  items: SaleLine[];
  payment: string;
  subtotal: number;
  discountPercentage: number;
  discountAmount: number;
  total: number;
  paid?: number;
  debt?: number;
  paymentMethodInitial?: string;
}

interface Customer {
  id: number;
  name: string;
  phone: string;
  cedula?: string | null;
  direccion?: string | null;
  saldoDeuda: number;
}

interface ManagedInventoryUser extends InventoryUser {
  createdAt: string | Date;
}

const products: Product[] = [];
const customers: Customer[] = [];
const movements: Movement[] = [];
const sales: Sale[] = [];
const categories: Array<{ id: number; nombre: string }> = [];
const tallas: Array<{ id: number; nombre: string; orden: number }> = [];
const colors: Array<{ id: number; nombre: string }> = [];
const inventoryUsers: ManagedInventoryUser[] = [];

const cart = new Map<string, number>();
const deletedProductSnapshots = new Map<number, Product>();
const editedProductSnapshots = new Map<number, Product>();
let activeCategory = "Todas";
let toastTimeout = 0;
let currentUser: InventoryUser | null = null;
let editingSaleId: string | null = null;
let realtimeSocket: Socket | null = null;
let realtimeRefreshTimeout = 0;
let realtimeRefreshInProgress = false;
let realtimeRefreshPending = false;
let openCustomerAccountId: number | null = null;
let pendingProductDeleteId: number | null = null;
const apiUrl = import.meta.env.PUBLIC_API_URL ?? "http://localhost:3000";
byId<HTMLDialogElement>("customer-account-modal")?.addEventListener(
  "close",
  () => {
    openCustomerAccountId = null;
  },
);
const currency = new Intl.NumberFormat("es-EC", {
  style: "currency",
  currency: "USD",
});
const shortDate = new Intl.DateTimeFormat("es-EC", {
  day: "2-digit",
  month: "short",
});
const dateTime = new Intl.DateTimeFormat("es-EC", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function byId<T extends Element = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function productFor(id: number): Product | undefined {
  return (
    products.find((product) => product.id === id) ??
    editedProductSnapshots.get(id)
  );
}

function variantFor(
  id: number,
): { product: Product; variant: ProductVariant } | undefined {
  for (const product of [...products, ...editedProductSnapshots.values()]) {
    const variant = product.variants.find((item) => item.id === id);
    if (variant) return { product, variant };
  }
}

function variantLabel(variant: Pick<ProductVariant, "size" | "color">): string {
  const size = variant.size === "Única" ? "" : variant.size;
  return [size, variant.color].filter(Boolean).join(" · ") || "Única";
}

function productNameWithoutColor(product: Product): string {
  const colorSuffix = product.variants
    .flatMap((variant) => (variant.color ? [` + ${variant.color}`] : []))
    .find((suffix) => product.name.endsWith(suffix));
  return colorSuffix
    ? product.name.slice(0, -colorSuffix.length).trimEnd()
    : product.name;
}

function categoryIs(name: string, singular: string): boolean {
  const normalized = name.trim().toLocaleLowerCase("es");
  return normalized === singular || normalized === `${singular}s`;
}

function cartKey(variantId: number, presentation: "UNIDAD" | "CAJA"): string {
  return `${variantId}:${presentation}`;
}

function parseCartKey(key: string): {
  variantId: number;
  presentation: "UNIDAD" | "CAJA";
} {
  const [rawVariantId, rawPresentation] = key.split(":");
  return {
    variantId: Number(rawVariantId),
    presentation: rawPresentation === "CAJA" ? "CAJA" : "UNIDAD",
  };
}

function presentationUnits(
  product: Product,
  presentation: "UNIDAD" | "CAJA",
): number {
  return presentation === "CAJA" ? (product.unitsPerBox ?? 0) : 1;
}

function presentationPrice(
  product: Product,
  presentation: "UNIDAD" | "CAJA",
  variant?: ProductVariant,
): number {
  return presentation === "CAJA"
    ? (product.boxPrice ?? 0)
    : (variant?.price ?? product.price);
}

function productPriceLabel(product: Product): string {
  const prices = product.variants.map((variant) => variant.price ?? product.price);
  if (!prices.length) return currency.format(product.price);
  const minimum = Math.min(...prices);
  const maximum = Math.max(...prices);
  return minimum === maximum
    ? currency.format(minimum)
    : `${currency.format(minimum)} – ${currency.format(maximum)}`;
}

function normalizedProduct(
  product: Omit<Product, "tone" | "initials">,
): Product {
  const tones = [
    "bg-orange-100 text-orange-700",
    "bg-sky-100 text-sky-700",
    "bg-violet-100 text-violet-700",
    "bg-amber-100 text-amber-700",
    "bg-teal-100 text-teal-700",
    "bg-rose-100 text-rose-700",
    "bg-lime-100 text-lime-800",
  ];
  return {
    ...product,
    tone: tones[product.id % tones.length],
    initials: product.name
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase(),
  };
}

function notify(message: string): void {
  const toast = byId("toast");
  if (!toast) return;
  const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
  if (dialog) {
    dialog.append(toast);
    toast.classList.add("modal-toast");
    dialog.addEventListener(
      "close",
      () => {
        if (toast.parentElement !== dialog) return;
        document.body.append(toast);
        toast.classList.remove("modal-toast");
      },
      { once: true },
    );
  } else {
    document.body.append(toast);
    toast.classList.remove("modal-toast");
  }
  window.clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.classList.remove("translate-y-[-8px]", "opacity-0");
  toast.classList.add("translate-y-0", "opacity-100");
  toastTimeout = window.setTimeout(() => {
    toast.classList.add("translate-y-[-8px]", "opacity-0");
    toast.classList.remove("translate-y-0", "opacity-100");
    if (!document.querySelector("dialog[open]")) {
      document.body.append(toast);
      toast.classList.remove("modal-toast");
    }
  }, 2600);
}

function setAuthenticatedView(user: InventoryUser): void {
  currentUser = user;
  connectRealtimeUpdates();
  const login = byId<HTMLElement>("login-screen");
  const dashboard = byId<HTMLElement>("dashboard-app");
  if (login) login.hidden = true;
  if (dashboard) dashboard.hidden = false;
  document
    .querySelectorAll<HTMLElement>("[data-admin-only]")
    .forEach((element) => {
      element.toggleAttribute("hidden", user.rol !== "ADMIN");
    });
  const username = byId("sidebar-username");
  if (username) username.textContent = user.username;
  const role = byId("sidebar-role");
  if (role)
    role.textContent =
      user.rol === "ADMIN" ? "Administrador" : "Usuario normal";
  const greeting = byId("overview-greeting");
  if (greeting) greeting.firstChild!.textContent = `Hola, ${user.username} `;
}

function setTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("xaprint-inventario-theme", theme);
  const dark = theme === "dark";
  document
    .querySelectorAll<HTMLButtonElement>("[data-theme-toggle]")
    .forEach((button) => {
      button.setAttribute("aria-pressed", String(dark));
      button.setAttribute(
        "aria-label",
        dark ? "Activar modo claro" : "Activar modo oscuro",
      );
      const icon = button.querySelector("[data-theme-icon]");
      const label = button.querySelector("[data-theme-label]");
      if (icon) icon.textContent = dark ? "☀" : "☾";
      if (label) label.textContent = dark ? "Modo claro" : "Modo oscuro";
    });
}

document
  .querySelectorAll<HTMLButtonElement>("[data-theme-toggle]")
  .forEach((button) => {
    button.addEventListener("click", () => {
      setTheme(
        document.documentElement.dataset.theme === "dark" ? "light" : "dark",
      );
    });
  });
setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");

function showLogin(message = ""): void {
  currentUser = null;
  realtimeSocket?.disconnect();
  realtimeSocket = null;
  const login = byId<HTMLElement>("login-screen");
  const dashboard = byId<HTMLElement>("dashboard-app");
  if (dashboard) dashboard.hidden = true;
  if (login) login.hidden = false;
  const error = byId("login-error");
  if (error) {
    error.textContent = message;
    error.classList.toggle("hidden", !message);
  }
}

window.addEventListener("inventario:unauthorized", () => {
  showLogin("La sesión expiró. Inicia sesión de nuevo.");
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && realtimeRefreshPending) {
    realtimeRefreshPending = false;
    refreshForRealtimeChange();
  }
});

async function loadDashboardData(): Promise<void> {
  if (!currentUser) return;
  const productPath =
    currentUser.rol === "ADMIN" ? "/productos" : "/productos/venta";
  const [
    clientesApi,
    productosApi,
    ventasApi,
    movimientosApi,
    categoriasApi,
    tallasApi,
    coloresApi,
    usuariosApi,
  ] = await Promise.all([
    inventoryRequest<
      Array<{
        id: number;
        nombre: string;
        telefono: string;
        cedula?: string | null;
        direccion?: string | null;
        saldoDeuda: number;
      }>
    >("/clientes"),
    inventoryRequest<Array<Omit<Product, "tone" | "initials">>>(productPath),
    inventoryRequest<Array<Omit<Sale, "date"> & { date: string | Date }>>(
      "/ventas",
    ),
    currentUser.rol === "ADMIN"
      ? inventoryRequest<
          Array<Omit<Movement, "date"> & { date: string | Date }>
        >("/movimientos")
      : Promise.resolve(
          [] as Array<Omit<Movement, "date"> & { date: string | Date }>,
        ),
    currentUser.rol === "ADMIN"
      ? inventoryRequest<Array<{ id: number; nombre: string }>>("/categorias")
      : Promise.resolve([] as Array<{ id: number; nombre: string }>),
    currentUser.rol === "ADMIN"
      ? inventoryRequest<Array<{ id: number; nombre: string; orden: number }>>(
          "/tallas",
        )
      : Promise.resolve(
          [] as Array<{ id: number; nombre: string; orden: number }>,
        ),
    currentUser.rol === "ADMIN"
      ? inventoryRequest<Array<{ id: number; nombre: string }>>("/colores")
      : Promise.resolve([] as Array<{ id: number; nombre: string }>),
    currentUser.rol === "ADMIN"
      ? inventoryRequest<ManagedInventoryUser[]>("/usuarios")
      : Promise.resolve([] as ManagedInventoryUser[]),
  ]);

  customers.splice(
    0,
    customers.length,
    ...clientesApi.map((cliente) => ({
      id: cliente.id,
      name: cliente.nombre,
      phone: cliente.telefono,
      cedula: cliente.cedula,
      direccion: cliente.direccion,
      saldoDeuda: cliente.saldoDeuda,
    })),
  );
  products.splice(0, products.length, ...productosApi.map(normalizedProduct));
  sales.splice(
    0,
    sales.length,
    ...ventasApi.map((sale) => ({
      ...sale,
      date: new Date(sale.date),
    })),
  );
  movements.splice(
    0,
    movements.length,
    ...movimientosApi.map((movement) => ({
      ...movement,
      date: new Date(movement.date),
    })),
  );
  categories.splice(0, categories.length, ...categoriasApi);
  tallas.splice(0, tallas.length, ...tallasApi);
  colors.splice(0, colors.length, ...coloresApi);
  inventoryUsers.splice(0, inventoryUsers.length, ...usuariosApi);
  renderCategoryOptions();
  renderProductVariantFields();
  renderTallas();
  renderColores();
  renderCategories();
  refreshViews();
  renderCustomers();
  renderCustomersTable();
  renderInventoryUsers();
}

async function authenticate(username: string, password: string): Promise<void> {
  const result = await loginInventory(username, password);
  setAuthenticatedView(result.usuario);
  await loadDashboardData();
}

byId("login-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const button = byId<HTMLButtonElement>("login-submit");
  const error = byId("login-error");
  if (button) button.disabled = true;
  if (error) {
    error.textContent = "";
    error.classList.add("hidden");
  }
  try {
    await authenticate(
      String(data.get("username") ?? "").trim(),
      String(data.get("password") ?? ""),
    );
  } catch (cause) {
    showLogin(
      cause instanceof Error ? cause.message : "No se pudo iniciar sesión.",
    );
  } finally {
    if (button) button.disabled = false;
  }
});

byId("logout-button")?.addEventListener("click", () => {
  clearInventoryToken();
  showLogin();
});

function emptyRow(message: string, columns: number): string {
  return `<tr><td colspan="${columns}" class="py-10 text-center text-sm text-slate-400">${message}</td></tr>`;
}

function movementBadge(type: Movement["type"]): string {
  const styles: Record<Movement["type"], string> = {
    Ingreso: "bg-emerald-50 text-emerald-700",
    Salida: "bg-rose-50 text-rose-700",
    Venta: "bg-sky-50 text-sky-700",
  };
  return `<span class="rounded-md px-2 py-1 text-[10px] font-bold ${styles[type]}">${type}</span>`;
}

function renderSummary(): void {
  const today = new Date().toDateString();
  const todaySales = sales.filter((sale) => sale.date.toDateString() === today);
  const lowStock = products.filter((product) =>
    product.variants.some((variant) => variant.stock <= variant.minStock),
  );
  const setText = (id: string, text: string) => {
    const node = byId(id);
    if (node) node.textContent = text;
  };

  setText("metric-products", String(products.length));
  setText(
    "metric-stock",
    products
      .reduce((total, product) => total + product.stock, 0)
      .toLocaleString("es-EC"),
  );
  setText(
    "metric-sales",
    currency.format(todaySales.reduce((total, sale) => total + sale.total, 0)),
  );
  setText("metric-sales-count", `${todaySales.length} transacciones`);
  setText("metric-low-stock", String(lowStock.length));
  setText("low-stock-badge", `${lowStock.length} alertas`);
  setText("sidebar-product-count", String(products.length));

  const lowList = byId("low-stock-list");
  if (lowList) {
    lowList.innerHTML = lowStock.length
      ? lowStock
          .map(
            (
              product,
            ) => `<div class="flex items-center gap-3 rounded-xl px-1 py-3">
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${product.tone} text-[10px] font-bold">${escapeHtml(product.initials)}</div>
          <div class="min-w-0 flex-1"><p class="truncate text-xs font-semibold text-slate-700">${escapeHtml(product.name)}</p><p class="mt-1 text-[10px] text-slate-400">Revisar: ${product.variants.filter((variant) => variant.stock <= variant.minStock).map((variant) => `${escapeHtml(variantLabel(variant))} (mín. ${variant.minStock})`).join(", ")}</p></div>
          <span class="rounded-md bg-rose-50 px-2 py-1 text-[11px] font-bold text-rose-700">${product.stock} uds.</span>
        </div>`,
          )
          .join("")
      : '<p class="py-7 text-center text-sm text-slate-400">¡Todo está abastecido!</p>';
  }
}

function renderMovements(): void {
  const sorted = [...movements].sort(
    (a, b) => b.date.getTime() - a.date.getTime(),
  );
  const rows = (items: Movement[], overview = false) =>
    items
      .map((movement) => {
        const product = productFor(movement.productId) ??
          deletedProductSnapshots.get(movement.productId) ?? {
            name: movement.productName ?? "Producto",
            tone: "bg-slate-100 text-slate-700",
            initials: (movement.productName ?? "P")
              .split(/\s+/)
              .slice(0, 2)
              .map((word) => word[0])
              .join("")
              .toUpperCase(),
          };
        return `<tr>
      <td><div class="flex items-center gap-3"><span class="hidden h-8 w-8 items-center justify-center rounded-lg ${product.tone} text-[10px] font-bold sm:flex">${escapeHtml(product.initials)}</span><span class="font-semibold text-slate-700">${escapeHtml(product.name)} · ${escapeHtml(movement.size)}</span></div></td>
      <td>${movementBadge(movement.type)}</td>
      <td class="text-right font-semibold ${movement.type === "Ingreso" ? "text-emerald-700" : "text-slate-600"}">${movement.type === "Ingreso" ? "+" : "−"}${movement.quantity}</td>
      ${
        overview
          ? `<td class="text-right text-xs text-slate-400">${shortDate.format(movement.date)}</td>`
          : `<td class="text-slate-500">${escapeHtml(movement.user)}</td><td class="text-right text-xs text-slate-400">${dateTime.format(movement.date)}</td>`
      }
    </tr>`;
      })
      .join("");
  const overview = byId("overview-movements");
  const all = byId("movements-table");
  if (overview)
    overview.innerHTML = sorted.length
      ? rows(sorted.slice(0, 4), true)
      : emptyRow("Sin movimientos todavía.", 4);
  if (all)
    all.innerHTML = sorted.length
      ? rows(sorted)
      : emptyRow("Sin movimientos todavía.", 5);
  const count = byId("movement-count");
  if (count) count.textContent = `${sorted.length} movimientos`;
}

function renderCategoryOptions(selectedId?: number): void {
  const select = byId<HTMLSelectElement>("product-category");
  if (!select) return;
  const selected = selectedId ?? Number(select.value);
  select.innerHTML = categories
    .map(
      (category) =>
        `<option value="${category.id}">${escapeHtml(category.nombre)}</option>`,
    )
    .join("");
  if (categories.some((category) => category.id === selected)) {
    select.value = String(selected);
  } else if (categories[0]) {
    select.value = String(categories[0].id);
  }
  select.disabled = categories.length === 0;
}

function renderTallas(): void {
  const list = byId("tallas-list");
  if (!list) return;
  list.innerHTML = tallas
    .map(
      (talla) =>
        `<li class="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700"><span>${escapeHtml(talla.nombre)}${talla.nombre === "Única" ? ' <small class="text-slate-400">(sistema)</small>' : ""}</span>${talla.nombre === "Única" ? "" : `<span class="flex gap-3"><button type="button" class="text-xs font-semibold text-blue-700" data-size-edit="${talla.id}">Editar</button><button type="button" class="text-xs font-semibold text-rose-600" data-size-delete="${talla.id}">Eliminar</button></span>`}</li>`,
    )
    .join("");
}

function renderColores(): void {
  const list = byId("colores-list");
  if (list) {
    list.innerHTML = colors
      .map(
        (color) =>
          `<li class="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700"><span>${escapeHtml(color.nombre)}</span><span class="flex gap-3"><button type="button" class="text-xs font-semibold text-blue-700" data-color-edit="${color.id}">Editar</button><button type="button" class="text-xs font-semibold text-rose-600" data-color-delete="${color.id}">Eliminar</button></span></li>`,
      )
      .join("") || '<li class="text-xs text-slate-400">Todavía no hay colores.</li>';
  }
}

function resetSizeForm(): void {
  const form = byId<HTMLFormElement>("talla-form");
  if (!form) return;
  form.reset();
  (form.elements.namedItem("sizeId") as HTMLInputElement).value = "";
  byId("size-form-label")!.textContent = "Nueva talla";
  byId("save-size-button")!.textContent = "Agregar";
  byId("cancel-size-edit")?.classList.add("hidden");
}

function resetColorForm(): void {
  const form = byId<HTMLFormElement>("color-form");
  if (!form) return;
  form.reset();
  (form.elements.namedItem("colorId") as HTMLInputElement).value = "";
  byId("color-form-label")!.textContent = "Nuevo color";
  byId("save-color-button")!.textContent = "Agregar";
  byId("cancel-color-edit")?.classList.add("hidden");
}

function collectProductVariantDrafts(): ProductVariant[] {
  return [
    ...(byId("product-variants")?.querySelectorAll<HTMLElement>(
      "[data-variant-row]",
    ) ?? []),
  ].map((row) => {
    const tallaId = Number(row.dataset.variantSize);
    const sizePrice = byId("product-size-prices")?.querySelector<HTMLInputElement>(
      `[data-size-price="${tallaId}"]`,
    );
    return {
      id: Number(row.dataset.variantId ?? 0),
      tallaId,
      colorId: Number(row.dataset.variantColor) || null,
      size: row.dataset.sizeName ?? "",
      color: row.dataset.colorName || null,
      sku: "",
      barcode: "",
      stock: Number(
        row.querySelector<HTMLInputElement>("[data-variant-stock]")?.value ?? 0,
      ),
      minStock: Number(
        row.querySelector<HTMLInputElement>("[data-variant-min-stock]")?.value ??
          0,
      ),
      price: Number(sizePrice?.value ?? row.dataset.variantPrice ?? 0),
    };
  });
}

function renderProductVariantFields(
  selectedVariants?: ProductVariant[],
): void {
  const container = byId("product-variants");
  if (!container) return;
  const currentDrafts = selectedVariants ?? collectProductVariantDrafts();
  const sizesContainer = byId("product-sizes");
  const sizePricesContainer = byId("product-size-prices");
  const colorsContainer = byId("product-colors");
  const selectedSizeIds =
    selectedVariants !== undefined
      ? [
          ...new Set(
            selectedVariants
              .filter((variant) => variant.size !== "Única")
              .map((variant) => variant.tallaId),
          ),
        ]
      : [
          ...(sizesContainer?.querySelectorAll<HTMLInputElement>(
            "[data-size-option]:checked",
          ) ?? []),
        ].map((input) => Number(input.dataset.sizeOption));
  const selectedColorIds =
    selectedVariants !== undefined
      ? [
          ...new Set(
            selectedVariants.flatMap((variant) =>
              variant.colorId === null ? [] : [variant.colorId],
            ),
          ),
        ]
      : [
          ...(colorsContainer?.querySelectorAll<HTMLInputElement>(
            "[data-color-option]:checked:not([data-color-option='none'])",
          ) ?? []),
        ].map((input) => Number(input.dataset.colorOption));
  const noColorSelected =
    selectedVariants !== undefined
      ? selectedVariants.some((variant) => variant.colorId === null)
      : Boolean(
          colorsContainer?.querySelector<HTMLInputElement>(
            "[data-color-option='none']:checked",
          ),
        );
  const categoryId = Number(
    byId<HTMLSelectElement>("product-category")?.value ?? 0,
  );
  const categoryName =
    categories.find((category) => category.id === categoryId)?.nombre ?? "";
  const isGarment = categoryIs(categoryName, "prenda");
  const isSupply = categoryIs(categoryName, "insumo");
  const variantLegend = byId("product-variants-label");
  if (variantLegend) {
    variantLegend.textContent = isGarment
      ? "Tallas y existencias iniciales"
      : "Existencias iniciales";
  }
  byId("box-options")?.classList.toggle("hidden", !isSupply);
  byId("size-options")?.classList.toggle("hidden", !isGarment);
  byId("color-options")?.classList.toggle("hidden", !isGarment);
  const boxToggle = byId<HTMLInputElement>("product-sells-by-box");
  const boxFields = byId("box-price-fields");
  const unitsInput = byId<HTMLFormElement>("product-form")?.elements.namedItem(
    "unitsPerBox",
  ) as HTMLInputElement | null;
  const boxPriceInput = byId<HTMLFormElement>("product-form")?.elements.namedItem(
    "boxPrice",
  ) as HTMLInputElement | null;
  if (!isSupply && boxToggle) {
    boxToggle.checked = false;
    if (unitsInput) unitsInput.value = "";
    if (boxPriceInput) boxPriceInput.value = "";
  }
  const boxEnabled = isSupply && Boolean(boxToggle?.checked);
  if (boxFields instanceof HTMLElement) boxFields.hidden = !boxEnabled;
  if (unitsInput) unitsInput.required = boxEnabled;
  if (boxPriceInput) boxPriceInput.required = boxEnabled;

  const chosenSizes = new Set(selectedSizeIds);
  const sizePrices = new Map<number, number>();
  for (const variant of currentDrafts) {
    if (
      !sizePrices.has(variant.tallaId) &&
      variant.price !== undefined &&
      variant.price > 0
    ) {
      sizePrices.set(variant.tallaId, variant.price);
    }
  }
  for (const input of sizePricesContainer?.querySelectorAll<HTMLInputElement>(
    "[data-size-price]",
  ) ?? []) {
    const price = Number(input.value);
    if (Number.isFinite(price) && price > 0) {
      sizePrices.set(Number(input.dataset.sizePrice), price);
    }
  }
  if (sizesContainer) {
    sizesContainer.innerHTML = tallas
      .filter((talla) => talla.nombre !== "Única")
      .map(
        (talla) =>
          `<label class="flex items-center gap-1.5 text-xs font-medium text-slate-600"><input type="checkbox" class="accent-blue-700" data-size-option="${talla.id}" ${chosenSizes.has(talla.id) ? "checked" : ""} />${escapeHtml(talla.nombre)}</label>`,
      )
      .join("") || '<span class="text-xs text-slate-400">Agrega tallas antes de crear una prenda.</span>';
  }
  if (sizePricesContainer) {
    const basePriceInput = byId<HTMLFormElement>("product-form")?.elements
      .namedItem("price");
    const defaultPrice =
      basePriceInput instanceof HTMLInputElement
        ? Number(basePriceInput.value)
        : 0;
    sizePricesContainer.innerHTML = selectedSizeIds
      .map((tallaId) => {
        const talla = tallas.find((item) => item.id === tallaId);
        const hasStoredPrice = currentDrafts.some(
          (variant) => variant.tallaId === tallaId && (variant.price ?? 0) > 0,
        );
        return `<label class="form-label">${escapeHtml(talla?.nombre ?? "Talla")} · Precio<input class="form-input" type="number" min="0.01" step="0.01" required data-size-price="${tallaId}" data-size-price-default="${hasStoredPrice ? "false" : "true"}" value="${sizePrices.get(tallaId) ?? (defaultPrice > 0 ? defaultPrice : "")}" /></label>`;
      })
      .join("");
  }
  if (colorsContainer) {
    const colorOptions = colors
      .map(
        (color) =>
          `<label class="flex items-center gap-1.5 text-xs font-medium text-slate-600"><input type="checkbox" class="accent-blue-700" data-color-option="${color.id}" ${selectedColorIds.includes(color.id) ? "checked" : ""} />${escapeHtml(color.nombre)}</label>`,
      )
      .join("");
    colorsContainer.innerHTML = `<label class="flex items-center gap-1.5 text-xs font-medium text-slate-600"><input type="checkbox" class="accent-blue-700" data-color-option="none" ${noColorSelected ? "checked" : ""} />Sin color</label>${colorOptions || '<span class="text-xs text-slate-400">Agrega colores en “Administrar colores”.</span>'}`;
  }

  const activeSizeIds = isGarment
    ? selectedSizeIds
    : [tallas.find((talla) => talla.nombre === "Única")?.id ?? 0];
  const activeColorIds: Array<number | null> = isGarment
    ? [...selectedColorIds]
    : [null];
  if (isGarment && noColorSelected) activeColorIds.push(null);
  if (!activeColorIds.length) activeColorIds.push(null);

  const variants = activeSizeIds.flatMap((tallaId) =>
    activeColorIds.map((colorId) => {
      const talla = tallas.find((item) => item.id === tallaId);
      const color = colors.find((item) => item.id === colorId);
      const previous = currentDrafts.find(
        (variant) =>
          variant.tallaId === tallaId && variant.colorId === colorId,
      );
      return { tallaId, colorId, talla, color, previous };
    }),
  );
  container.innerHTML = variants
    .filter((variant) => variant.tallaId > 0)
    .map(({ tallaId, colorId, talla, color, previous }) => {
      const label = [talla?.nombre, color?.nombre].filter(Boolean).join(" · ");
      return `<div class="grid grid-cols-[1fr_1fr_1fr] items-center gap-2 rounded-lg bg-slate-50 p-2" data-variant-row data-variant-id="${previous?.id ?? ""}" data-variant-size="${tallaId}" data-variant-color="${colorId ?? ""}" data-variant-price="${previous?.price ?? ""}" data-size-name="${escapeHtml(talla?.nombre ?? "")}" data-color-name="${escapeHtml(color?.nombre ?? "")}">
        <span class="text-sm font-semibold text-slate-700">${escapeHtml(label)}</span>
        <label class="text-[10px] font-medium text-slate-500">Stock<input class="form-input mt-1 h-8 px-2 text-xs" type="number" min="0" step="1" data-variant-stock value="${previous?.stock ?? 0}" /></label>
        <label class="text-[10px] font-medium text-slate-500">Mínimo<input class="form-input mt-1 h-8 px-2 text-xs" type="number" min="0" step="1" data-variant-min-stock value="${previous?.minStock ?? 5}" /></label>
      </div>`;
    })
    .join("") ||
    `<p class="text-xs text-slate-400">${isGarment ? "Selecciona al menos una talla para configurar sus existencias." : "Selecciona colores o configura el stock de la variante única."}</p>`;
}

function renderCategories(): void {
  const table = byId("categories-table");
  const empty = byId("categories-empty");
  if (table) {
    table.innerHTML =
      categories
        .map(
          (category) => `
      <tr>
        <td class="font-semibold text-slate-700">${escapeHtml(category.nombre)}</td>
        <td class="text-right">
          <div class="flex justify-end gap-2">
            <button type="button" class="text-xs font-semibold text-blue-700 hover:underline" data-category-edit="${category.id}">Editar</button>
            <button type="button" class="text-xs font-semibold text-rose-600 hover:underline" data-category-delete="${category.id}">Eliminar</button>
          </div>
        </td>
      </tr>`,
        )
        .join("") || emptyRow("Todavía no hay categorías.", 2);
  }
  empty?.classList.toggle("hidden", categories.length > 0);
  const count = byId("category-count");
  if (count)
    count.textContent = `${categories.length} ${categories.length === 1 ? "categoría" : "categorías"}`;
}

function renderInventoryUsers(): void {
  const table = byId("inventory-users-table");
  const empty = byId("inventory-users-empty");
  if (table) {
    table.innerHTML =
      inventoryUsers
        .map((user) => {
          const isCurrentUser = user.id === currentUser?.id;
          const created = new Date(user.createdAt);
          return `<tr>
        <td class="font-semibold text-slate-700">${escapeHtml(user.username)}${isCurrentUser ? '<span class="ml-2 text-[10px] font-medium text-slate-400">Tú</span>' : ""}</td>
        <td><span class="rounded-full px-2.5 py-1 text-[10px] font-bold ${user.rol === "ADMIN" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}">${user.rol === "ADMIN" ? "Administrador" : "Normal"}</span></td>
        <td class="text-xs text-slate-500">${Number.isNaN(created.getTime()) ? "—" : shortDate.format(created)}</td>
        <td class="text-right">
          <div class="flex justify-end gap-2">
            <button type="button" class="text-xs font-semibold text-blue-700 hover:underline" data-user-edit="${user.id}">Editar</button>
            ${
              isCurrentUser
                ? '<span class="px-1 text-xs text-slate-300" title="No puedes eliminar tu propia sesión">Eliminar</span>'
                : `<button type="button" class="text-xs font-semibold text-rose-600 hover:underline" data-user-delete="${user.id}">Eliminar</button>`
            }
          </div>
        </td>
      </tr>`;
        })
        .join("") || emptyRow("No hay usuarios registrados.", 4);
  }
  empty?.classList.toggle("hidden", inventoryUsers.length > 0);
  const count = byId("inventory-user-count");
  if (count) {
    count.textContent = `${inventoryUsers.length} ${inventoryUsers.length === 1 ? "usuario" : "usuarios"}`;
  }
}

function renderCustomersTable(): void {
  const query =
    byId<HTMLInputElement>("customer-crud-search")
      ?.value.trim()
      .toLocaleLowerCase("es") ?? "";
  const filtered = customers.filter((customer) => {
    const matchesQuery =
      `${customer.name} ${customer.phone} ${customer.cedula ?? ""} ${customer.direccion ?? ""}`
        .toLocaleLowerCase("es")
        .includes(query);
    return matchesQuery && (query.length > 0 || customer.saldoDeuda > 0);
  });
  const table = byId("customers-table");
  if (table) {
    table.innerHTML =
      filtered
        .map(
          (customer) => `<tr>
          <td class="font-semibold text-slate-700">${escapeHtml(customer.name)}</td>
          <td>${escapeHtml(customer.phone)}</td>
          <td class="text-slate-500">${escapeHtml(customer.cedula || "—")}</td>
          <td class="max-w-xs truncate text-slate-500" title="${escapeHtml(customer.direccion || "")}">${escapeHtml(customer.direccion || "—")}</td>
          <td class="font-semibold ${customer.saldoDeuda > 0 ? "text-rose-700" : "text-slate-400"}">${currency.format(customer.saldoDeuda)}</td>
          <td class="text-right">
           <div class="flex justify-end gap-2">
             <button type="button" class="text-xs font-semibold ${customer.saldoDeuda > 0 ? "text-rose-700" : "text-blue-700"} hover:underline" data-customer-account="${customer.id}">Cuenta</button>
             <button type="button" class="text-xs font-semibold text-blue-700 hover:underline" data-customer-edit="${customer.id}">Editar</button>
              <button type="button" class="text-xs font-semibold text-rose-600 hover:underline" data-customer-delete="${customer.id}">Eliminar</button>
            </div>
          </td>
        </tr>`,
        )
        .join("");
  }
  const empty = byId("customers-crud-empty");
  if (empty) {
    empty.textContent = query
      ? "No se encontraron clientes con esa búsqueda."
      : "No hay clientes con deudas pendientes.";
    empty.classList.toggle("hidden", filtered.length > 0);
  }
  const count = byId("customer-crud-count");
  if (count) {
    count.textContent = query
      ? `${filtered.length} resultado(s) · búsqueda en ${customers.length} clientes`
      : `${filtered.length} cliente(s) con deuda`;
  }
}

function refreshForRealtimeChange(): void {
  if (!currentUser) return;
  if (document.hidden) {
    realtimeRefreshPending = true;
    return;
  }
  if (realtimeRefreshInProgress) {
    realtimeRefreshPending = true;
    return;
  }
  realtimeRefreshInProgress = true;
  void loadDashboardData()
    .then(async () => {
      const accountId = openCustomerAccountId;
      if (
        accountId !== null &&
        byId<HTMLDialogElement>("customer-account-modal")?.open
      ) {
        await openCustomerAccount(accountId, true);
      }
    })
    .catch((cause: unknown) => {
      console.error("No se pudo sincronizar el inventario en tiempo real:", cause);
    })
    .finally(() => {
      realtimeRefreshInProgress = false;
      if (realtimeRefreshPending) {
        realtimeRefreshPending = false;
        refreshForRealtimeChange();
      }
    });
}

function connectRealtimeUpdates(): void {
  if (realtimeSocket) return;
  realtimeSocket = io(`${apiUrl}/pedidos`, { transports: ["websocket"] });
  const scheduleRefresh = () => {
    window.clearTimeout(realtimeRefreshTimeout);
    realtimeRefreshTimeout = window.setTimeout(refreshForRealtimeChange, 150);
  };
  realtimeSocket.on("connect", scheduleRefresh);
  realtimeSocket.on("inventarioActualizado", scheduleRefresh);
  realtimeSocket.on("finanzasActualizadas", scheduleRefresh);
  realtimeSocket.on("pedidoActualizado", scheduleRefresh);
  realtimeSocket.on("connect_error", (cause: Error) => {
    console.error("No se pudo conectar a las actualizaciones en tiempo real:", cause.message);
  });
}

async function openCustomerAccount(
  customerId: number,
  onlyIfAlreadyOpen = false,
): Promise<void> {
  const dialog = byId<HTMLDialogElement>("customer-account-modal");
  const content = byId("customer-account-content");
  if (!dialog || !content) return;
  if (onlyIfAlreadyOpen) {
    if (!dialog.open || openCustomerAccountId !== customerId) return;
  } else {
    openCustomerAccountId = customerId;
  }
  try {
    const account = await inventoryRequest<{
      cliente: { id: number; nombre: string; telefono: string };
      saldoDeuda: number;
      ventas: Array<{
        id: string;
        fecha: string | Date;
        subtotal: number;
        descuentoPorcentaje: number;
        descuentoMonto: number;
        total: number;
        pagado: number;
        saldo: number;
        items: Array<{
          nombre: string;
          talla: string;
          presentacion: string;
          cantidad: number;
          total: number;
        }>;
      }>;
      abonos: Array<{
        id: number;
        venta: string;
        monto: number;
        metodoPago: string;
        fecha: string | Date;
        usuario: string;
      }>;
    }>(`/clientes/${customerId}/cuenta`);
    if (
      onlyIfAlreadyOpen &&
      (!dialog.open || openCustomerAccountId !== customerId)
    ) {
      return;
    }
    content.innerHTML = `
      <div class="modal-heading">
        <div><h2 class="text-lg font-bold">Cuenta de ${escapeHtml(account.cliente.nombre)}</h2><p class="mt-1 text-xs text-slate-500">${escapeHtml(account.cliente.telefono)}</p></div>
        <button type="button" class="modal-close" data-close="customer-account-modal" aria-label="Cerrar">✕</button>
      </div>
      <div class="max-h-[70vh] space-y-5 overflow-y-auto p-5">
        <div class="rounded-xl ${account.saldoDeuda > 0 ? "bg-rose-50" : "bg-emerald-50"} p-4">
          <p class="text-xs font-semibold text-slate-500">Saldo pendiente</p>
          <p class="mt-1 text-2xl font-bold ${account.saldoDeuda > 0 ? "text-rose-700" : "text-emerald-700"}">${currency.format(account.saldoDeuda)}</p>
        </div>
        <section>
          <h3 class="mb-2 text-sm font-bold text-slate-700">Ventas a crédito</h3>
          <div class="space-y-2">
            ${account.ventas.map((venta) => `<article class="rounded-xl border border-[#edf0ec] p-3">
              <div class="flex items-start justify-between gap-3">
                <div><p class="text-xs font-bold text-slate-700">${escapeHtml(venta.id)} · ${dateTime.format(new Date(venta.fecha))}</p>
                  <p class="mt-1 text-[11px] text-slate-500">${venta.items.map((item) => `${escapeHtml(item.nombre)} ${escapeHtml(item.talla)} × ${item.cantidad} ${item.presentacion === "CAJA" ? "(caja)" : ""}`).join(", ")}</p>
                </div>
                <div class="shrink-0 text-right text-xs">
                  <p>Subtotal ${currency.format(venta.subtotal)}</p>${venta.descuentoPorcentaje > 0 ? `<p class="text-rose-600">Descuento ${venta.descuentoPorcentaje}% · −${currency.format(venta.descuentoMonto)}</p>` : ""}<p>Total ${currency.format(venta.total)}</p><p class="text-emerald-700">Abonado ${currency.format(venta.pagado)}</p>
                  <p class="font-bold ${venta.saldo > 0 ? "text-rose-700" : "text-slate-500"}">Debe ${currency.format(venta.saldo)}</p>
                </div>
              </div>
            </article>`).join("") || '<p class="text-xs text-slate-400">No hay ventas a crédito registradas.</p>'}
          </div>
        </section>
        <section>
          <h3 class="mb-2 text-sm font-bold text-slate-700">Historial de abonos</h3>
          <div class="overflow-x-auto rounded-xl border border-[#edf0ec]">
            <table class="data-table"><thead><tr><th>Fecha</th><th>Venta</th><th>Método</th><th>Usuario</th><th class="text-right">Monto</th></tr></thead>
            <tbody>${account.abonos.map((abono) => `<tr><td>${dateTime.format(new Date(abono.fecha))}</td><td>${escapeHtml(abono.venta)}</td><td>${escapeHtml(abono.metodoPago)}</td><td>${escapeHtml(abono.usuario)}</td><td class="text-right font-semibold">${currency.format(abono.monto)}</td></tr>`).join("") || '<tr><td colspan="5" class="py-5 text-center text-xs text-slate-400">Sin abonos todavía.</td></tr>'}</tbody>
            </table>
          </div>
        </section>
        ${account.saldoDeuda > 0 ? `<form id="customer-account-payment-form" class="grid gap-3 rounded-xl bg-[#f7f9f6] p-4 sm:grid-cols-[1fr_1fr_auto]">
          <label class="form-label">Nuevo abono ($)<input class="form-input mt-1" name="amount" type="number" min="0.01" max="${account.saldoDeuda.toFixed(2)}" step="0.01" required /></label>
          <label class="form-label">Método<select class="form-input mt-1" name="method"><option>Efectivo</option><option>Transferencia</option><option>Tarjeta</option></select></label>
          <button type="submit" class="primary-button self-end">Registrar abono</button>
        </form>` : ""}
      </div>
      <div class="flex justify-end border-t border-[#edf0ec] p-4"><button type="button" class="secondary-button" data-close="customer-account-modal">Cerrar</button></div>`;
    if (!dialog.open) dialog.showModal();
    byId("customer-account-payment-form")?.addEventListener(
      "submit",
      async (event) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const data = new FormData(form);
        const monto = Number(data.get("amount"));
        if (!Number.isFinite(monto) || monto <= 0) {
          notify("Ingresa un monto de abono válido.");
          return;
        }
        try {
          const result = await inventoryRequest<{ monto: number }>(
            `/clientes/${customerId}/abonos`,
            {
              method: "POST",
              body: JSON.stringify({
                monto,
                metodoPago: String(data.get("method")),
              }),
            },
          );
          await loadDashboardData();
          await openCustomerAccount(customerId);
          notify(`Abono de ${currency.format(result.monto)} registrado.`);
        } catch (cause) {
          notify(
            cause instanceof Error
              ? cause.message
              : "No se pudo registrar el abono.",
          );
        }
      },
    );
  } catch (cause) {
    notify(
      cause instanceof Error
        ? cause.message
        : "No se pudo cargar la cuenta del cliente.",
    );
  }
}

function renderProducts(): void {
  const search =
    byId<HTMLInputElement>("product-search")?.value.trim().toLowerCase() ?? "";
  const category = byId<HTMLSelectElement>("category-filter")?.value ?? "";
  const filtered = [...products, ...editedProductSnapshots.values()].filter(
    (product) =>
      `${product.name} ${product.sku} ${product.barcode} ${product.variants
        .map((variant) => `${variantLabel(variant)} ${variant.sku} ${variant.barcode} ${variant.legacyBarcode ?? ""}`)
        .join(" ")}`
        .toLowerCase()
        .includes(search) &&
      (!category || product.category === category),
  );
  const table = byId("products-table");
  const empty = byId("products-empty");
  if (table)
    table.innerHTML =
      filtered
        .map((product) => {
          const low = product.variants.some(
            (variant) => variant.stock <= variant.minStock,
          );
          const out = product.stock === 0;
          return `<tr>
      <td><div class="flex items-center gap-3"><span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${product.tone} text-[10px] font-bold">${escapeHtml(product.initials)}</span><span class="font-semibold text-slate-700">${escapeHtml(product.name)}</span></div></td>
      <td class="font-mono text-xs text-slate-400">${escapeHtml(product.sku)}</td>
      <td><div class="flex flex-wrap gap-1">${product.variants
        .map(
          (variant) => `<span class="inline-flex items-center gap-1 rounded-md bg-slate-50 px-2 py-1 text-[10px]">
            <span class="font-semibold text-slate-600">${escapeHtml(variantLabel(variant))} · ${variant.stock}</span>
            <button class="font-mono text-blue-700 hover:underline" data-variant-barcode="${variant.id}" title="Ver código de ${escapeHtml(variantLabel(variant))}">${escapeHtml(variant.barcode)}</button>
            <button class="font-bold text-blue-700" data-add-stock="${variant.id}" title="Agregar stock a ${escapeHtml(variantLabel(variant))}">＋</button>
          </span>`,
        )
        .join("")}</div></td>
      <td class="text-slate-500">${escapeHtml(product.category)}</td>
      <td class="font-semibold text-slate-700">${productPriceLabel(product)}</td>
      <td><span class="font-semibold ${low ? "text-rose-700" : "text-slate-700"}">${product.stock}</span><span class="ml-1 text-[10px] text-slate-400">uds.</span></td>
      <td><span class="rounded-full px-2.5 py-1 text-[10px] font-bold ${out ? "bg-slate-100 text-slate-500" : low ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}">${out ? "Agotado" : low ? "Stock bajo" : "Disponible"}</span></td>
      <td class="text-right">
        <div class="flex items-center justify-end gap-1">
          <details class="product-options">
            <summary class="options-trigger" aria-label="Opciones de ${escapeHtml(product.name)}" title="Opciones del producto">⋯</summary>
            <div class="options-menu">
              <button type="button" data-product-edit="${product.id}">Editar producto</button>
              <button type="button" data-product-delete="${product.id}" class="text-rose-600">Eliminar producto</button>
            </div>
          </details>
        </div>
      </td>
    </tr>`;
        })
        .join("") || emptyRow("No encontramos productos con esos filtros.", 8);
  empty?.classList.add("hidden");

  const productCategories = [
    ...new Set(products.map((product) => product.category)),
  ];
  const select = byId<HTMLSelectElement>("category-filter");
  if (select) {
    const selected = select.value;
    select.innerHTML =
      '<option value="">Todas las categorías</option>' +
      productCategories
        .map(
          (item) =>
            `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`,
        )
        .join("");
    select.value = productCategories.includes(selected) ? selected : "";
  }
  renderSummary();
}

function renderPos(): void {
  const search =
    byId<HTMLInputElement>("pos-search")?.value.trim().toLowerCase() ?? "";
  const editedSale = sales.find((sale) => sale.id === editingSaleId);
  const filtered = products.flatMap((product) =>
    product.variants
      .filter(
        (variant) =>
          availableForSale(variant, editedSale) > 0 &&
          `${product.name} ${product.sku} ${product.barcode} ${variantLabel(variant)} ${variant.sku} ${variant.barcode}`
            .toLowerCase()
            .includes(search) &&
          (activeCategory === "Todas" || product.category === activeCategory),
      )
      .map((variant) => ({ product, variant })),
  );
  const container = byId("pos-products");
  if (container)
    container.innerHTML = filtered
      .map(
        ({ product, variant }) => `
    <button class="product-tile group text-left" data-cart-add="${variant.id}">
      <div class="flex h-28 items-center justify-center rounded-xl ${product.tone} transition group-hover:brightness-[0.98]">
        <span class="text-2xl font-black tracking-wide opacity-70">${escapeHtml(variantLabel(variant))}</span>
      </div>
      <div class="mt-3 flex items-start justify-between gap-2">
        <div class="min-w-0"><p class="truncate text-xs font-semibold text-slate-700">${escapeHtml(product.name)}</p><p class="mt-1 text-[10px] text-slate-400">${escapeHtml(variantLabel(variant))} · ${availableForSale(variant, editedSale)} disponibles</p></div>
        <span class="shrink-0 text-right text-xs font-bold text-blue-700">${currency.format(variant.price ?? product.price)}${product.unitsPerBox && product.boxPrice ? `<small class="block text-[9px] font-medium text-slate-400">${currency.format(product.boxPrice)} / caja</small>` : ""}</span>
      </div>
    </button>
  `,
      )
      .join("");
  byId("pos-empty")?.classList.toggle("hidden", filtered.length > 0);

  const categories = [
    "Todas",
    ...new Set(products.map((product) => product.category)),
  ];
  const chips = byId("category-chips");
  if (chips)
    chips.innerHTML = categories
      .map(
        (category) =>
          `<button class="category-chip ${activeCategory === category ? "is-selected" : ""}" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`,
      )
      .join("");
  renderCart();
}

function renderCart(): void {
  const entries = [...cart.entries()]
    .map(([key, quantity]) => {
      const { variantId, presentation } = parseCartKey(key);
      return {
        key,
        item: variantFor(variantId),
        presentation,
        quantity,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        key: string;
        item: { product: Product; variant: ProductVariant };
        presentation: "UNIDAD" | "CAJA";
        quantity: number;
      } => Boolean(entry.item),
    );
  const items = byId("cart-items");
  const itemCount = entries.reduce((total, entry) => total + entry.quantity, 0);
  const subtotal = entries.reduce(
    (sum, entry) =>
      sum +
      presentationPrice(
        entry.item.product,
        entry.presentation,
        entry.item.variant,
      ) *
        entry.quantity,
    0,
  );
  const discountInput = byId<HTMLInputElement>("sale-discount");
  const discountPercentage = Number(discountInput?.value ?? 0);
  const discountValid =
    Number.isFinite(discountPercentage) &&
    discountPercentage >= 0 &&
    discountPercentage <= 100;
  const discountAmount = discountValid
    ? Math.round(subtotal * discountPercentage) / 100
    : 0;
  const total = Math.round((subtotal - discountAmount) * 100) / 100;
  if (items)
    items.innerHTML = entries
      .map(
        ({ item, quantity, presentation, key }) => {
          const unidades = presentationUnits(item.product, presentation);
          const maximum = availableForCart(
            item.variant,
            unidades,
            key,
          );
          const linePrice = presentationPrice(
            item.product,
            presentation,
            item.variant,
          );
          return `
    <div class="space-y-2.5 py-3.5">
      <div class="min-w-0">
        <p class="break-words text-xs font-semibold leading-4 text-slate-700">${escapeHtml(item.product.name)}</p>
        <p class="mt-0.5 text-[10px] text-slate-500">${escapeHtml(variantLabel(item.variant))}</p>
      </div>
      <div class="flex min-w-0 items-center justify-between gap-2">
        <div class="min-w-0 flex-1">
          ${item.product.unitsPerBox && item.product.boxPrice ? `<label class="block text-[9px] font-medium text-slate-400">Presentación<select class="form-input mt-0.5 h-7 w-full max-w-40 px-2 text-[10px]" data-cart-presentation="${item.variant.id}" data-current-presentation="${presentation}"><option value="UNIDAD" ${presentation === "UNIDAD" ? "selected" : ""}>Unidad</option><option value="CAJA" ${presentation === "CAJA" ? "selected" : ""}>Caja (${item.product.unitsPerBox})</option></select></label>` : ""}
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <label class="text-[10px] text-slate-500" for="cart-quantity-${key}">Cantidad</label>
          <input id="cart-quantity-${key}" class="form-input h-7 w-14 px-1 text-center text-xs" type="number" min="1" max="${maximum}" step="1" value="${quantity}" data-cart-quantity="${key}" aria-label="Cantidad de ${presentation === "CAJA" ? "cajas" : "unidades"} de ${escapeHtml(item.product.name)}" />
        </div>
      </div>
      <div class="flex items-center justify-between border-t border-slate-100 pt-2">
        <span class="text-[10px] text-slate-400">${currency.format(linePrice)} c/u</span>
        <strong class="text-xs font-bold text-slate-700">${currency.format(linePrice * quantity)}</strong>
      </div>
    </div>`;
        },
      )
      .join("");
  byId("cart-count")!.textContent = String(itemCount);
  byId("cart-peek-total")!.textContent = currency.format(total);
  byId("cart-subtotal")!.textContent = currency.format(subtotal);
  byId("cart-discount-row")?.classList.toggle(
    "hidden",
    !discountValid || discountPercentage <= 0,
  );
  byId("cart-discount-label")!.textContent =
    `Descuento (${discountPercentage || 0}%)`;
  byId("cart-discount")!.textContent = `−${currency.format(discountAmount)}`;
  byId("cart-total")!.textContent = currency.format(total);
  byId("cart-empty")?.classList.toggle("hidden", entries.length > 0);
  const hasCustomer = Boolean(
    byId<HTMLInputElement>("selected-customer-id")?.value,
  );
  const isCredit =
    byId<HTMLSelectElement>("payment-method")?.value === "Crédito";
  byId("credit-initial-payment")?.classList.toggle("hidden", !isCredit);
  const initialPaymentInput = byId<HTMLInputElement>("initial-payment-amount");
  if (initialPaymentInput) {
    initialPaymentInput.max = total.toFixed(2);
  }
  const initialPayment = Number(initialPaymentInput?.value ?? 0);
  const initialPaymentValid =
    !isCredit ||
    (Number.isFinite(initialPayment) &&
      initialPayment >= 0 &&
      initialPayment <= total);
  const completeButton = byId<HTMLButtonElement>("complete-sale");
  if (completeButton) {
    completeButton.disabled =
      entries.length === 0 ||
      !hasCustomer ||
      !initialPaymentValid ||
      !discountValid;
    completeButton.textContent = editingSaleId
      ? "Guardar cambios de venta"
      : "Completar venta";
  }
  const requirements = byId("sale-requirements");
  if (requirements) {
    requirements.textContent = !discountValid
      ? "El descuento debe estar entre 0% y 100%."
      : !hasCustomer
      ? "Selecciona un cliente para completar la venta."
      : entries.length === 0
        ? "Agrega productos para continuar."
        : editingSaleId
          ? "Las existencias se ajustarán al guardar los cambios."
          : isCredit
            ? "Al confirmar se entregan los productos y se registra la deuda pendiente."
            : "El stock se actualizará al confirmar la venta.";
  }
}

function availableForSale(
  variant: ProductVariant,
  sale?: Sale,
  unitsPerPresentation = 1,
): number {
  const returned =
    sale?.items
      .filter((item) => item.variantId === variant.id)
      .reduce(
        (sum, item) => sum + item.quantity * item.unitsPerPresentation,
        0,
      ) ?? 0;
  return Math.floor((variant.stock + returned) / unitsPerPresentation);
}

function availableForCart(
  variant: ProductVariant,
  unitsPerPresentation: number,
  excludedKey?: string | string[],
): number {
  const product = variantFor(variant.id)?.product;
  if (!product || unitsPerPresentation < 1) return 0;
  const excludedKeys = new Set(
    Array.isArray(excludedKey) ? excludedKey : excludedKey ? [excludedKey] : [],
  );
  let remaining =
    variant.stock +
    (sales
      .find((sale) => sale.id === editingSaleId)
      ?.items.filter((item) => item.variantId === variant.id)
      .reduce(
        (sum, item) => sum + item.quantity * item.unitsPerPresentation,
        0,
      ) ?? 0);
  for (const [key, quantity] of cart) {
    if (excludedKeys.has(key)) continue;
    const parsed = parseCartKey(key);
    if (parsed.variantId !== variant.id) continue;
    remaining -=
      quantity *
      presentationUnits(product, parsed.presentation);
  }
  return Math.max(0, Math.floor(remaining / unitsPerPresentation));
}

function salesInDateRange(
  fromId: string,
  toId: string,
  errorId: string,
): Sale[] {
  const fromValue = byId<HTMLInputElement>(fromId)?.value ?? "";
  const toValue = byId<HTMLInputElement>(toId)?.value ?? "";
  const from = fromValue ? new Date(`${fromValue}T00:00:00`) : null;
  const to = toValue ? new Date(`${toValue}T23:59:59.999`) : null;
  const invalid = Boolean(from && to && from > to);
  byId(errorId)?.classList.toggle("hidden", !invalid);
  if (invalid) return [];

  return sales.filter(
    (sale) => (!from || sale.date >= from) && (!to || sale.date <= to),
  );
}

function renderSales(): void {
  const table = byId("sales-table");
  const empty = byId("sales-empty");
  const range = salesInDateRange(
    "history-date-from",
    "history-date-to",
    "history-date-error",
  );
  const search =
    byId<HTMLInputElement>("history-search")
      ?.value.trim()
      .toLocaleLowerCase("es") ?? "";
  const payment = byId<HTMLSelectElement>("history-payment")?.value ?? "";
  const ordered = range
    .filter(
      (sale) =>
        (!payment || sale.payment === payment) &&
        (!search ||
          [
            sale.id,
            sale.customerName,
            sale.customerPhone ?? "",
            ...sale.items.map((item) => `${item.name} ${item.size}`),
          ].some((value) => value.toLocaleLowerCase("es").includes(search))),
    )
    .sort((a, b) => b.date.getTime() - a.date.getTime());
  const total = ordered.reduce((sum, sale) => sum + sale.total, 0);
  const units = ordered.reduce(
    (sum, sale) =>
      sum + sale.items.reduce((itemSum, item) => itemSum + item.quantity, 0),
    0,
  );
  const setText = (id: string, value: string) => {
    const element = byId(id);
    if (element) element.textContent = value;
  };

  setText("history-total", currency.format(total));
  setText("history-count", String(ordered.length));
  setText(
    "history-average",
    currency.format(ordered.length ? total / ordered.length : 0),
  );
  setText("history-units", String(units));
  setText(
    "history-result-count",
    `${ordered.length} ${ordered.length === 1 ? "venta" : "ventas"}${range.length !== ordered.length ? ` de ${range.length}` : ""}`,
  );

  if (table)
    table.innerHTML = ordered
      .map(
        (sale) => `
    <tr>
      <td class="font-mono text-xs font-semibold text-blue-700">${escapeHtml(sale.id)}</td>
      <td class="font-medium text-slate-700">${escapeHtml(sale.customerName)}</td>
      <td class="text-xs text-slate-500">${dateTime.format(sale.date)}</td>
      <td class="text-slate-600">${sale.items.reduce((sum, item) => sum + item.quantity, 0)} artículos</td>
      <td><span class="rounded-md bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-600">${escapeHtml(sale.payment)}</span></td>
      <td class="text-right"><strong class="font-bold text-slate-700">${currency.format(sale.total)}</strong>${sale.discountPercentage > 0 ? `<small class="block text-[10px] font-medium text-rose-600">−${sale.discountPercentage}% · ${currency.format(sale.discountAmount)}</small>` : ""}</td>
      <td>
        <div class="flex items-center justify-end gap-1">
        ${sale.payment === "Crédito" ? '<button class="sale-action cursor-not-allowed opacity-45" type="button" disabled title="Las ventas a crédito no se pueden editar">No editable</button>' : `<button class="sale-action" data-sale-edit="${escapeHtml(sale.id)}">Editar</button>`}
          <button class="sale-action" data-sale-print="${escapeHtml(sale.id)}">Imprimir</button>
        </div>
      </td>
    </tr>`,
      )
      .join("");
  empty?.classList.toggle("hidden", ordered.length > 0);
  renderSummary();
}

function renderSalesStats(): void {
  const range = salesInDateRange(
    "stats-date-from",
    "stats-date-to",
    "stats-date-error",
  );
  const total = range.reduce((sum, sale) => sum + sale.total, 0);
  const units = range.reduce(
    (sum, sale) =>
      sum + sale.items.reduce((itemSum, item) => itemSum + item.quantity, 0),
    0,
  );
  const setText = (id: string, value: string) => {
    const element = byId(id);
    if (element) element.textContent = value;
  };
  setText("stats-total", currency.format(total));
  setText("stats-count", String(range.length));
  setText(
    "stats-average",
    currency.format(range.length ? total / range.length : 0),
  );
  setText("stats-units", String(units));

  const dailyMap = new Map<
    string,
    { date: Date; total: number; count: number }
  >();
  const paymentMap = new Map<string, { total: number; count: number }>();
  const productMap = new Map<
    string,
    { name: string; quantity: number; total: number }
  >();
  for (const sale of range) {
    const day = `${sale.date.getFullYear()}-${String(sale.date.getMonth() + 1).padStart(2, "0")}-${String(sale.date.getDate()).padStart(2, "0")}`;
    const daily = dailyMap.get(day) ?? { date: sale.date, total: 0, count: 0 };
    daily.total += sale.total;
    daily.count += 1;
    dailyMap.set(day, daily);

    const payment = paymentMap.get(sale.payment) ?? { total: 0, count: 0 };
    payment.total += sale.total;
    payment.count += 1;
    paymentMap.set(sale.payment, payment);

    for (const item of sale.items) {
      const productName = `${item.name} · ${item.size}`;
      const product = productMap.get(productName) ?? {
        name: productName,
        quantity: 0,
        total: 0,
      };
      product.quantity += item.quantity;
      product.total += item.quantity * item.price;
      productMap.set(productName, product);
    }
  }

  const daily = [...dailyMap.values()].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
  const maxDaily = Math.max(1, ...daily.map((item) => item.total));
  const dailyContainer = byId("stats-daily");
  if (dailyContainer)
    dailyContainer.innerHTML = daily
      .map((item) => {
        const width = Math.max(4, (item.total / maxDaily) * 100);
        return `<div>
      <div class="mb-1.5 flex items-center justify-between gap-3 text-xs"><span class="font-semibold text-slate-600">${escapeHtml(new Intl.DateTimeFormat("es-EC", { day: "2-digit", month: "short", year: "numeric" }).format(item.date))}</span><span class="text-slate-400">${item.count} ${item.count === 1 ? "venta" : "ventas"} · ${currency.format(item.total)}</span></div>
      <div class="h-2 overflow-hidden rounded-full bg-[#edf2ed]"><div class="h-full rounded-full bg-[#41815d]" style="width:${width}%"></div></div>
    </div>`;
      })
      .join("");
  byId("stats-daily-empty")?.classList.toggle("hidden", daily.length > 0);

  const paymentEntries = [...paymentMap.entries()].sort(
    (a, b) => b[1].total - a[1].total,
  );
  const maxPayment = Math.max(
    1,
    ...paymentEntries.map(([, item]) => item.total),
  );
  const paymentContainer = byId("stats-payments");
  if (paymentContainer)
    paymentContainer.innerHTML = paymentEntries
      .map(([method, item]) => {
        const width = Math.max(4, (item.total / maxPayment) * 100);
        return `<div>
      <div class="mb-1.5 flex items-center justify-between gap-3 text-xs"><span class="font-semibold text-slate-600">${escapeHtml(method)} <span class="font-normal text-slate-400">(${item.count})</span></span><span class="font-semibold text-slate-700">${currency.format(item.total)}</span></div>
      <div class="h-2 overflow-hidden rounded-full bg-[#edf2ed]"><div class="h-full rounded-full bg-[#77a987]" style="width:${width}%"></div></div>
    </div>`;
      })
      .join("");
  byId("stats-payments-empty")?.classList.toggle(
    "hidden",
    paymentEntries.length > 0,
  );

  const bestProducts = [...productMap.values()].sort(
    (a, b) => b.quantity - a.quantity || b.total - a.total,
  );
  const productTable = byId("stats-products");
  if (productTable)
    productTable.innerHTML = bestProducts
      .map(
        (item, index) => `
    <tr><td class="text-slate-400">${index + 1}</td><td class="font-semibold text-slate-700">${escapeHtml(item.name)}</td><td class="text-right font-semibold">${item.quantity}</td><td class="text-right font-semibold text-slate-700">${currency.format(item.total)}</td></tr>
  `,
      )
      .join("");
  byId("stats-products-empty")?.classList.toggle(
    "hidden",
    bestProducts.length > 0,
  );
}

function csvCell(value: string | number): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function exportSalesCsv(): void {
  const search =
    byId<HTMLInputElement>("history-search")
      ?.value.trim()
      .toLocaleLowerCase("es") ?? "";
  const payment = byId<HTMLSelectElement>("history-payment")?.value ?? "";
  const filtered = salesInDateRange(
    "history-date-from",
    "history-date-to",
    "history-date-error",
  )
    .filter(
      (sale) =>
        (!payment || sale.payment === payment) &&
        (!search ||
          [
            sale.id,
            sale.customerName,
            sale.customerPhone ?? "",
            ...sale.items.map((item) => `${item.name} ${item.size}`),
          ].some((value) => value.toLocaleLowerCase("es").includes(search))),
    )
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  if (filtered.length === 0) {
    notify("No hay ventas para exportar con esos filtros.");
    return;
  }

  const headers = [
    "Venta",
    "Fecha",
    "Cliente",
    "Teléfono",
    "Método de pago",
    "Productos",
    "Unidades",
    "Subtotal",
    "Descuento (%)",
    "Descuento ($)",
    "Total",
  ];
  const rows = filtered.map((sale) => [
    sale.id,
    sale.date.toLocaleString("sv-SE"),
    sale.customerName,
    sale.customerPhone ?? "",
    sale.payment,
    sale.items
      .map((item) => `${item.name} (${item.size}) x${item.quantity}`)
      .join(" | "),
    sale.items.reduce((sum, item) => sum + item.quantity, 0),
    sale.subtotal.toFixed(2),
    sale.discountPercentage.toFixed(2),
    sale.discountAmount.toFixed(2),
    sale.total.toFixed(2),
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "ventas-xaprint.csv";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function receiptMarkup(sale: Sale): string {
  return `
    <header class="receipt-brand">
      <strong>XAPRINT</strong>
      <span>Comprobante de venta</span>
    </header>
    <div class="receipt-meta">
      <div><span>N.º de venta</span><strong>${escapeHtml(sale.id)}</strong></div>
      <div><span>Fecha</span><strong>${escapeHtml(dateTime.format(sale.date))}</strong></div>
      <div><span>Cliente</span><strong>${escapeHtml(sale.customerName)}</strong></div>
      ${sale.customerPhone ? `<div><span>Teléfono</span><strong>${escapeHtml(sale.customerPhone)}</strong></div>` : ""}
      <div><span>Método de pago</span><strong>${escapeHtml(sale.payment)}</strong></div>
    </div>
    <div class="receipt-lines">
      <div class="receipt-line receipt-line-heading"><span>Producto</span><span>Cant.</span><span>Total</span></div>
      ${sale.items
        .map(
          (item) => `
        <div class="receipt-line">
          <span>${escapeHtml(item.name)} · ${escapeHtml(item.size)}<small>${currency.format(item.price)} c/u</small></span>
          <span>${item.quantity}</span>
          <strong>${currency.format(item.quantity * item.price)}</strong>
        </div>`,
        )
        .join("")}
    </div>
    <div class="receipt-total"><span>Subtotal</span><strong>${currency.format(sale.subtotal)}</strong></div>
    ${sale.discountPercentage > 0 ? `<div class="receipt-total"><span>Descuento (${sale.discountPercentage}%)</span><strong>−${currency.format(sale.discountAmount)}</strong></div>` : ""}
    <div class="receipt-total"><span>Total</span><strong>${currency.format(sale.total)}</strong></div>
    <p class="receipt-thanks">Gracias por tu compra</p>`;
}

function showSaleConfirmation(sale: Sale): void {
  const content = byId("sale-confirm-content");
  const dialog = byId<HTMLDialogElement>("sale-confirm-modal");
  if (!content || !dialog) return;
  const itemCount = sale.items.reduce((sum, item) => sum + item.quantity, 0);
  const editing = editingSaleId !== null;
  const credit = sale.payment === "Crédito";
  content.innerHTML = `
    <div class="modal-heading">
      <div><h2 class="text-lg font-bold">${editing ? `Guardar cambios de ${escapeHtml(editingSaleId!)}` : credit ? "Confirmar entrega a crédito" : "Confirmar venta"}</h2><p class="mt-1 text-xs text-slate-500">${editing ? "Revisa los cambios antes de actualizar la venta." : credit ? "Se entregan los productos ahora y el saldo se registra como deuda del cliente." : "Revisa los detalles antes de confirmar el cobro."}</p></div>
      <button type="button" class="modal-close" data-close="sale-confirm-modal" aria-label="Cerrar">✕</button>
    </div>
    <div class="space-y-4 p-5">
      <div class="grid gap-3 rounded-xl bg-[#f7f9f6] p-4 sm:grid-cols-2">
        <div><p class="receipt-field-label">Cliente</p><p class="receipt-field-value">${escapeHtml(sale.customerName)}</p></div>
        <div><p class="receipt-field-label">Método de pago</p><p class="receipt-field-value">${escapeHtml(sale.payment)}</p></div>
      </div>
      <div class="overflow-hidden rounded-xl border border-[#edf0ec]">
        <div class="flex items-center justify-between bg-[#fafbf9] px-4 py-3 text-[10px] font-bold uppercase tracking-wide text-slate-400"><span>Productos · ${itemCount} artículos</span><span>Importe</span></div>
        <div class="divide-y divide-[#edf0ec] px-4">
          ${sale.items.map((item) => `<div class="flex items-center justify-between gap-4 py-3 text-sm"><span class="min-w-0"><span class="font-semibold text-slate-700">${escapeHtml(item.name)} · ${escapeHtml(item.size)}</span><span class="ml-2 text-xs text-slate-400">× ${item.quantity} ${item.presentation === "CAJA" ? `caja(s) de ${item.unitsPerPresentation}` : "unidad(es)"}</span></span><span class="shrink-0 font-semibold text-slate-700">${currency.format(item.quantity * item.price)}</span></div>`).join("")}
        </div>
        <div class="space-y-2 border-t border-[#edf0ec] bg-[#fafbf9] px-4 py-4">
          <div class="flex items-center justify-between text-xs text-slate-500"><span>Subtotal</span><span>${currency.format(sale.subtotal)}</span></div>
          ${sale.discountPercentage > 0 ? `<div class="flex items-center justify-between text-xs font-semibold text-rose-600"><span>Descuento (${sale.discountPercentage}%)</span><span>−${currency.format(sale.discountAmount)}</span></div>` : ""}
          <div class="flex items-center justify-between"><span class="text-sm font-bold text-slate-600">Total</span><strong class="text-lg font-bold text-blue-700">${currency.format(sale.total)}</strong></div>
          ${credit ? `<div class="flex items-center justify-between text-xs"><span>Abono al entregar · ${escapeHtml(String(sale.paymentMethodInitial ?? "Efectivo"))}</span><strong>${currency.format(sale.paid ?? 0)}</strong></div><div class="flex items-center justify-between text-sm font-bold text-rose-700"><span>Deuda pendiente</span><strong>${currency.format(sale.debt ?? sale.total)}</strong></div>` : ""}
        </div>
      </div>
      <p class="text-xs ${credit ? "font-semibold text-amber-800" : "text-slate-400"}">${credit ? "Confirma para entregar los productos y registrar la deuda. Si cancelas, no se guardará ni se descontará el stock." : editing ? "Al guardar, se actualizarán la venta y las existencias." : "Al confirmar, se registrará la venta y se actualizarán las existencias."}</p>
    </div>
    <div class="flex justify-end gap-2 border-t border-[#edf0ec] p-4">
      <button type="button" class="secondary-button" data-close="sale-confirm-modal">Volver a la venta</button>
      <button type="button" id="confirm-sale-button" class="primary-button">${editing ? "Guardar cambios" : credit ? "Confirmar entrega y deuda" : "Confirmar venta"} · ${currency.format(sale.total)}</button>
    </div>`;
  byId<HTMLButtonElement>("confirm-sale-button")?.addEventListener(
    "click",
    (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      button.textContent = "Procesando venta...";
      void confirmSale(sale);
    },
  );
  dialog.showModal();
}

function downloadSaleReceipt(sale: Sale): void {
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  const right = pageWidth - margin;
  let y = 24;

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(20);
  pdf.setTextColor(23, 61, 50);
  pdf.text("XAPRINT", pageWidth / 2, y, { align: "center" });

  y += 7;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);
  pdf.setTextColor(113, 128, 120);
  pdf.text("Comprobante de venta", pageWidth / 2, y, { align: "center" });
  y += 7;
  pdf.setDrawColor(217, 225, 218);
  pdf.line(margin, y, right, y);

  y += 10;
  pdf.setFontSize(9);
  pdf.setTextColor(135, 146, 139);
  pdf.text("N.º DE VENTA", margin, y);
  pdf.text("FECHA", pageWidth / 2, y);
  y += 5;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(10);
  pdf.setTextColor(37, 49, 42);
  pdf.text(sale.id, margin, y);
  pdf.text(dateTime.format(sale.date), pageWidth / 2, y);

  y += 10;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  pdf.setTextColor(135, 146, 139);
  pdf.text("CLIENTE", margin, y);
  pdf.text("MÉTODO DE PAGO", pageWidth / 2, y);
  y += 5;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(10);
  pdf.setTextColor(37, 49, 42);
  const customerLines = pdf.splitTextToSize(
    sale.customerName,
    contentWidth / 2 - 5,
  );
  pdf.text(customerLines, margin, y);
  pdf.setFont("helvetica", "normal");
  pdf.text(sale.payment, pageWidth / 2, y);
  y += Math.max(customerLines.length * 5, 5);

  if (sale.customerPhone) {
    y += 4;
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);
    pdf.setTextColor(135, 146, 139);
    pdf.text("TELÉFONO", margin, y);
    y += 5;
    pdf.setFontSize(10);
    pdf.setTextColor(37, 49, 42);
    pdf.text(sale.customerPhone, margin, y);
  }

  y += 11;
  pdf.setFillColor(247, 249, 246);
  pdf.rect(margin, y - 5, contentWidth, 10, "F");
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(9);
  pdf.setTextColor(113, 128, 120);
  pdf.text("PRODUCTO", margin + 3, y + 1);
  pdf.text("CANT.", right - 38, y + 1, { align: "center" });
  pdf.text("TOTAL", right - 3, y + 1, { align: "right" });
  y += 10;

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);
  pdf.setTextColor(52, 65, 57);
  for (const item of sale.items) {
    const nameLines = pdf.splitTextToSize(
      `${item.name} · ${item.size}`,
      contentWidth - 75,
    );
    const rowHeight = Math.max(nameLines.length * 5, 10);
    if (y + rowHeight + 35 > pdf.internal.pageSize.getHeight()) {
      pdf.addPage();
      y = 22;
    }

    pdf.text(nameLines, margin + 3, y);
    pdf.setFontSize(8);
    pdf.setTextColor(135, 146, 139);
    pdf.text(
      `${currency.format(item.price)} c/u`,
      margin + 3,
      y + nameLines.length * 4,
    );
    pdf.setFontSize(10);
    pdf.setTextColor(52, 65, 57);
    pdf.text(String(item.quantity), right - 38, y, { align: "center" });
    pdf.text(currency.format(item.quantity * item.price), right - 3, y, {
      align: "right",
    });

    y += rowHeight + 5;
    pdf.setDrawColor(237, 240, 236);
    pdf.line(margin, y - 2, right, y - 2);
  }

  y += 6;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);
  pdf.setTextColor(113, 128, 120);
  pdf.text("Subtotal", margin + 3, y);
  pdf.text(currency.format(sale.subtotal), right - 3, y, { align: "right" });
  if (sale.discountPercentage > 0) {
    y += 6;
    pdf.setTextColor(190, 60, 75);
    pdf.text(`Descuento (${sale.discountPercentage}%)`, margin + 3, y);
    pdf.text(`-${currency.format(sale.discountAmount)}`, right - 3, y, {
      align: "right",
    });
  }
  y += 7;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(13);
  pdf.setTextColor(23, 61, 50);
  pdf.text("TOTAL", margin + 3, y);
  pdf.text(currency.format(sale.total), right - 3, y, { align: "right" });

  y += 15;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  pdf.setTextColor(135, 146, 139);
  pdf.text("Gracias por tu compra", pageWidth / 2, y, { align: "center" });

  pdf.save(`comprobante-${sale.id.toLowerCase()}.pdf`);
}

function showSaleReceipt(sale: Sale): void {
  const content = byId("sale-receipt-content");
  const dialog = byId<HTMLDialogElement>("sale-receipt-modal");
  if (!content || !dialog) return;
  content.innerHTML = `
    <div class="modal-heading receipt-actions-heading">
      <div class="flex items-center gap-3">
        <span class="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-50 text-lg font-bold text-emerald-700" aria-hidden="true">✓</span>
        <div><h2 class="text-lg font-bold">Venta confirmada</h2><p class="mt-1 text-xs text-slate-500">El comprobante ya está listo.</p></div>
      </div>
      <button type="button" class="modal-close" data-close="sale-receipt-modal" aria-label="Cerrar">✕</button>
    </div>
    <article id="sale-receipt-print" class="sale-receipt">${receiptMarkup(sale)}</article>
    <div class="receipt-actions flex flex-col-reverse justify-end gap-2 border-t border-[#edf0ec] p-4 sm:flex-row">
      <button type="button" class="secondary-button" data-close="sale-receipt-modal">Cerrar</button>
      <button type="button" id="download-sale-receipt" class="secondary-button">Descargar PDF</button>
      <button type="button" id="print-sale-receipt" class="primary-button">Imprimir comprobante</button>
    </div>`;
  byId("download-sale-receipt")?.addEventListener("click", () =>
    downloadSaleReceipt(sale),
  );
  byId("print-sale-receipt")?.addEventListener("click", () => window.print());
  dialog.showModal();
}

function openSaleReceipt(sale: Sale): void {
  showSaleReceipt(sale);
}

function openMovementFor(variantId?: number): void {
  const select = byId<HTMLSelectElement>("movement-product");
  const dialog = byId<HTMLDialogElement>("movement-modal");
  if (!select || !dialog) return;
  select.innerHTML = products
    .flatMap((product) =>
      product.variants.map(
        (variant) =>
          `<option value="${variant.id}">${escapeHtml(product.name)} · ${escapeHtml(variantLabel(variant))} · ${variant.stock} uds.</option>`,
      ),
    )
    .join("");
  if (variantId) select.value = String(variantId);
  dialog.showModal();
}

function renderCustomers(selectedId?: number): void {
  const hidden = byId<HTMLInputElement>("selected-customer-id");
  const search = byId<HTMLInputElement>("customer-search");
  const currentId = selectedId ?? Number(hidden?.value);
  const selected = customers.find((customer) => customer.id === currentId);
  if (hidden) hidden.value = selected ? String(selected.id) : "";
  const selectedContainer = byId("selected-customer");
  if (selectedContainer) {
    selectedContainer.classList.toggle("hidden", !selected);
    selectedContainer.innerHTML = selected
      ? `<span><strong>${escapeHtml(selected.name)}</strong><small>${escapeHtml(selected.phone)}</small></span><button type="button" id="clear-selected-customer" aria-label="Quitar cliente">×</button>`
      : "";
  }
  if (search) {
    search.value = selected ? "" : (search.value ?? "");
    search.classList.toggle("hidden", Boolean(selected));
    search.setAttribute("aria-expanded", "false");
  }
  const results = byId("customer-results");
  results?.classList.add("hidden");
  renderCart();
}

function renderCustomerResults(query: string): void {
  const results = byId("customer-results");
  const search = byId<HTMLInputElement>("customer-search");
  if (!results || !search) return;
  const normalized = query.trim().toLocaleLowerCase("es");
  const matches = customers
    .filter(
      (customer) =>
        !normalized ||
        `${customer.name} ${customer.phone} ${customer.cedula ?? ""} ${customer.direccion ?? ""}`
          .toLocaleLowerCase("es")
          .includes(normalized),
    )
    .slice(0, 8);
  results.innerHTML = matches.length
    ? matches
        .map(
          (customer) => `
      <button type="button" class="customer-result" role="option" data-customer-select="${customer.id}">
        <span>${escapeHtml(customer.name)}</span>
        <small>${escapeHtml(customer.phone)}</small>
      </button>`,
        )
        .join("")
    : '<p class="customer-no-results">No se encontraron clientes.</p>';
  results.classList.remove("hidden");
  search.setAttribute("aria-expanded", "true");
}

function showBarcode(product: Product, variant: ProductVariant): void {
  const content = byId("barcode-content");
  const dialog = byId<HTMLDialogElement>("barcode-modal");
  if (!content || !dialog) return;
  content.innerHTML = `
    <div class="modal-heading"><div><h2 class="text-lg font-bold">Código de barras</h2><p class="mt-1 text-xs text-slate-500">${escapeHtml(product.name)} · ${escapeHtml(variantLabel(variant))} · ${escapeHtml(variant.sku)}</p></div><button type="button" class="modal-close" data-close="barcode-modal" aria-label="Cerrar">✕</button></div>
    <div class="barcode-preview"><svg id="barcode-svg" role="img" aria-label="Código de barras ${escapeHtml(variant.barcode)}"></svg></div>
    <p class="pb-5 text-center font-mono text-xs tracking-wider text-slate-500">${escapeHtml(variant.barcode)}</p>
    <div class="flex justify-end gap-2 border-t border-[#edf0ec] p-4"><button type="button" class="secondary-button" data-close="barcode-modal">Cerrar</button><button type="button" id="print-barcode" class="primary-button">Imprimir código</button></div>`;
  const svg = byId<SVGSVGElement>("barcode-svg");
  if (svg) {
    JsBarcode(svg, variant.barcode, {
      format: "CODE128",
      displayValue: false,
      height: 70,
      margin: 8,
      background: "#ffffff",
      lineColor: "#1d4ed8",
    });
  }
  byId("print-barcode")?.addEventListener("click", () => window.print());
  dialog.showModal();
}

function openProductEditor(productId: number): void {
  const product = productFor(productId);
  const form = byId<HTMLFormElement>("product-form");
  const dialog = byId<HTMLDialogElement>("product-modal");
  if (!product || !form || !dialog) return;
  const data = new FormData();
  data.set("productId", String(product.id));
  data.set("name", productNameWithoutColor(product));
  data.set("price", String(product.price));
  data.set("unitsPerBox", product.unitsPerBox ? String(product.unitsPerBox) : "");
  data.set("boxPrice", product.boxPrice ? String(product.boxPrice) : "");
  form.reset();
  renderCategoryOptions(product.categoryId);
  const sellsByBox =
    product.unitsPerBox !== null && product.boxPrice !== null;
  const boxToggle = byId<HTMLInputElement>("product-sells-by-box");
  if (boxToggle) boxToggle.checked = sellsByBox;
  renderProductVariantFields(product.variants);
  for (const [name, value] of data) {
    const field = form.elements.namedItem(name);
    if (field instanceof HTMLInputElement) field.value = String(value);
  }
  const skuDisplay = byId<HTMLInputElement>("product-sku-display");
  if (skuDisplay) skuDisplay.value = product.sku;
  byId("product-modal-title")!.textContent = "Editar producto";
  byId("save-product-button")!.textContent = "Guardar cambios";
  dialog.showModal();
}

function openNewProductForm(): void {
  const form = byId<HTMLFormElement>("product-form");
  if (!form) return;
  form.reset();
  renderCategoryOptions();
  renderProductVariantFields([]);
  const skuDisplay = byId<HTMLInputElement>("product-sku-display");
  if (skuDisplay) skuDisplay.value = "Se asignará al guardar";
  byId("product-modal-title")!.textContent = "Nuevo producto";
  byId("save-product-button")!.textContent = "Guardar producto";
  byId<HTMLDialogElement>("product-modal")?.showModal();
}

function addProductToCart(variantId: number): void {
  const item = variantFor(variantId);
  if (!item) return;
  const { product, variant } = item;
  const key = cartKey(variant.id, "UNIDAD");
  const quantity = cart.get(key) ?? 0;
  if (quantity >= availableForCart(variant, 1, key)) {
    notify("No hay existencias suficientes para agregar otra unidad.");
    return;
  }
  cart.set(key, quantity + 1);
  renderCart();
}

function scanBarcode(value: string): void {
  const code = value.trim().toUpperCase();
  if (!code) return;
  const item = products
    .flatMap((product) =>
      product.variants.map((variant) => ({ product, variant })),
    )
    .find(
      ({ variant }) =>
        variant.barcode.toUpperCase() === code ||
        variant.legacyBarcode?.toUpperCase() === code ||
        variant.sku.toUpperCase() === code,
    );
  if (!item) {
    notify(`No encontramos un producto con el código ${code}.`);
  } else if (item.variant.stock < 1) {
    notify(`${item.product.name} ${variantLabel(item.variant)} no tiene existencias.`);
  } else {
    addProductToCart(item.variant.id);
    byId<HTMLInputElement>("barcode-input")?.focus();
  }
}

function setMobileCartOpen(open: boolean): void {
  const cartPanel = byId("sale-cart");
  const toggle = byId<HTMLButtonElement>("toggle-cart");
  const backdrop = byId<HTMLButtonElement>("cart-backdrop");
  if (!cartPanel || !toggle || !backdrop) return;

  cartPanel.classList.toggle("is-open", open);
  toggle.setAttribute("aria-expanded", String(open));
  toggle.textContent = open ? "Cerrar carrito" : "Ver carrito";
  backdrop.hidden = !open;
}

function switchView(view: string, title?: string): void {
  if (view !== "pos") setMobileCartOpen(false);
  document.querySelectorAll<HTMLElement>(".app-view").forEach((section) => {
    section.classList.toggle("hidden", section.id !== `view-${view}`);
  });
  document.querySelectorAll<HTMLButtonElement>(".nav-link").forEach((link) => {
    link.classList.toggle("is-active", link.dataset.view === view);
  });
  const activeLink = document.querySelector<HTMLButtonElement>(
    `.nav-link[data-view="${view}"]`,
  );
  const heading = title ?? activeLink?.dataset.title ?? "Resumen";
  byId("page-title")!.textContent = heading;
  byId("breadcrumb-title")!.textContent = heading;
  const posTitle = byId("pos-title");
  if (posTitle) {
    posTitle.textContent = editingSaleId
      ? `Editar ${editingSaleId}`
      : "Punto de venta";
  }

  byId("cancel-edit-sale")?.classList.toggle("hidden", !editingSaleId);
  closeSidebar();
  if (view === "products") renderProducts();
  if (view === "categories") renderCategories();
  if (view === "users") renderInventoryUsers();
  if (view === "customers") renderCustomersTable();
  if (view === "movements") renderMovements();
  if (view === "pos") {
    renderPos();
    window.setTimeout(
      () => byId<HTMLInputElement>("barcode-input")?.focus(),
      0,
    );
  }
  if (view === "sales") renderSales();
  if (view === "sales-stats") renderSalesStats();
}

function closeSidebar(): void {
  byId("sidebar")?.classList.add("-translate-x-full");
  byId("sidebar-scrim")?.classList.add("hidden");
}

document.querySelectorAll<HTMLButtonElement>(".nav-link").forEach((link) => {
  link.addEventListener("click", () =>
    switchView(link.dataset.view ?? "overview", link.dataset.title),
  );
});
document.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((button) => {
  button.addEventListener("click", () =>
    switchView(button.dataset.go ?? "overview"),
  );
});

document.addEventListener(
  "toggle",
  (event) => {
    const openedMenu = event.target;
    if (
      !(openedMenu instanceof HTMLDetailsElement) ||
      !openedMenu.matches(".product-options") ||
      !openedMenu.open
    ) {
      return;
    }
    document
      .querySelectorAll<HTMLDetailsElement>(
        "#products-table .product-options[open]",
      )
      .forEach((menu) => {
        if (menu !== openedMenu) menu.open = false;
      });
  },
  true,
);

byId("open-sidebar")?.addEventListener("click", () => {
  byId("sidebar")?.classList.remove("-translate-x-full");
  byId("sidebar-scrim")?.classList.remove("hidden");
});
byId("close-sidebar")?.addEventListener("click", closeSidebar);
byId("sidebar-scrim")?.addEventListener("click", closeSidebar);

byId("open-product-modal")?.addEventListener("click", openNewProductForm);
byId("open-tallas-modal")?.addEventListener("click", () => {
  resetSizeForm();
  renderTallas();
  byId<HTMLDialogElement>("tallas-modal")?.showModal();
});
byId("open-colores-modal")?.addEventListener("click", () => {
  resetColorForm();
  renderColores();
  byId<HTMLDialogElement>("colores-modal")?.showModal();
});
byId("open-movement-modal")?.addEventListener("click", () => openMovementFor());
function openCustomerForm(customer?: Customer): void {
  const form = byId<HTMLFormElement>("customer-form");
  const dialog = byId<HTMLDialogElement>("customer-modal");
  if (!form || !dialog) return;
  form.reset();
  (form.elements.namedItem("customerId") as HTMLInputElement).value = customer
    ? String(customer.id)
    : "";
  if (customer) {
    (form.elements.namedItem("name") as HTMLInputElement).value = customer.name;
    (form.elements.namedItem("phone") as HTMLInputElement).value =
      customer.phone;
    (form.elements.namedItem("cedula") as HTMLInputElement).value =
      customer.cedula ?? "";
    (form.elements.namedItem("direccion") as HTMLInputElement).value =
      customer.direccion ?? "";
  }
  byId("customer-modal-title")!.textContent = customer
    ? "Editar cliente"
    : "Nuevo cliente";
  byId("customer-modal-description")!.textContent = customer
    ? "Actualiza los datos del cliente."
    : "Agrega los datos de contacto del cliente.";
  byId("save-customer-button")!.textContent = customer
    ? "Guardar cambios"
    : "Guardar cliente";
  dialog.showModal();
}

byId("open-customer-modal")?.addEventListener("click", () =>
  openCustomerForm(),
);
byId("open-customer-crud")?.addEventListener("click", () => openCustomerForm());
document
  .querySelectorAll<HTMLButtonElement>("[data-close]")
  .forEach((button) => {
    button.addEventListener("click", () =>
      byId<HTMLDialogElement>(button.dataset.close ?? "")?.close(),
    );
  });

function resetCategoryForm(): void {
  const form = byId<HTMLFormElement>("category-form");
  form?.reset();
  if (form)
    (form.elements.namedItem("categoryId") as HTMLInputElement).value = "";
  const title = byId("category-form-title");
  if (title) title.textContent = "Nueva categoría";
  const saveButton = byId("save-category-button");
  if (saveButton) saveButton.textContent = "Crear categoría";
  byId("cancel-category-edit")?.classList.add("hidden");
}

byId("cancel-category-edit")?.addEventListener("click", resetCategoryForm);
byId("category-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const categoryId = Number(data.get("categoryId")) || null;
  const nombre = String(data.get("name") ?? "").trim();
  try {
    await inventoryRequest(
      categoryId ? `/categorias/${categoryId}` : "/categorias",
      {
        method: categoryId ? "PATCH" : "POST",
        body: JSON.stringify({ nombre }),
      },
    );
    resetCategoryForm();
    await loadDashboardData();
    notify(categoryId ? "Categoría actualizada." : "Categoría creada.");
  } catch (cause) {
    notify(
      cause instanceof Error
        ? cause.message
        : "No se pudo guardar la categoría.",
    );
  }
});

function resetInventoryUserForm(): void {
  const form = byId<HTMLFormElement>("inventory-user-form");
  if (!form) return;
  form.reset();
  (form.elements.namedItem("userId") as HTMLInputElement).value = "";
  const password = byId<HTMLInputElement>("inventory-user-password");
  if (password) password.required = true;
  const role = form.elements.namedItem("rol") as HTMLSelectElement;
  role.disabled = false;
  byId("inventory-user-form-title")!.textContent = "Nuevo usuario";
  byId("save-inventory-user-button")!.textContent = "Crear usuario";
  byId("inventory-user-password-help")?.classList.add("hidden");
  byId("cancel-inventory-user-edit")?.classList.add("hidden");
}

byId("cancel-inventory-user-edit")?.addEventListener(
  "click",
  resetInventoryUserForm,
);
byId("inventory-user-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const userId = Number(data.get("userId")) || null;
  const username = String(data.get("username") ?? "").trim();
  const password = String(data.get("password") ?? "");
  const role = form.elements.namedItem("rol") as HTMLSelectElement;
  const payload = userId
    ? {
        username,
        ...(password ? { password } : {}),
        ...(!role.disabled ? { rol: role.value } : {}),
      }
    : { username, password, rol: role.value };
  try {
    const savedUser = await inventoryRequest<InventoryUser>(
      userId ? `/usuarios/${userId}` : "/usuarios",
      {
        method: userId ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      },
    );
    if (currentUser?.id === savedUser.id) {
      setAuthenticatedView(savedUser);
    }
    resetInventoryUserForm();
    await loadDashboardData();
    notify(userId ? "Usuario actualizado." : "Usuario creado.");
  } catch (cause) {
    notify(
      cause instanceof Error ? cause.message : "No se pudo guardar el usuario.",
    );
  }
});

byId("product-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const productId = Number(data.get("productId")) || null;
  const name = String(data.get("name") ?? "").trim();
  const categoryId = Number(data.get("categoryId"));
  const variants = collectProductVariantDrafts().map((variant) => {
    return {
      tallaId: variant.tallaId,
      ...(variant.colorId ? { colorId: variant.colorId } : {}),
      existencia: variant.stock,
      stockMinimo: variant.minStock,
      precio: variant.price,
    };
  });
  const previous = productId ? productFor(productId) : undefined;
  if (productId && !previous) {
    notify("No encontramos el producto que intentas editar.");
    return;
  }
  if (!variants.length || variants.some((variant) =>
    !Number.isInteger(variant.existencia) ||
    variant.existencia < 0 ||
    !Number.isInteger(variant.stockMinimo) ||
    variant.stockMinimo < 0 ||
    typeof variant.precio !== "number" ||
    !Number.isFinite(variant.precio) ||
    variant.precio <= 0
  )) {
    notify("Configura variantes con precio y valores de stock válidos.");
    return;
  }
  const categoryName =
    categories.find((category) => category.id === categoryId)?.nombre ?? "";
  const isSupply = categoryIs(categoryName, "insumo");
  const sellsByBox =
    isSupply &&
    Boolean(byId<HTMLInputElement>("product-sells-by-box")?.checked);
  const payload = {
    nombre: name,
    categoriaId: categoryId,
    precio: Number(data.get("price")),
    unidadesPorCaja: sellsByBox
      ? String(data.get("unitsPerBox") ?? "").trim() === ""
        ? null
        : Number(data.get("unitsPerBox"))
      : null,
    precioCaja: sellsByBox
      ? String(data.get("boxPrice") ?? "").trim() === ""
        ? null
        : Number(data.get("boxPrice"))
      : null,
    variantes: variants,
  };
  const saveButton = byId<HTMLButtonElement>("save-product-button");
  if (saveButton) saveButton.disabled = true;
  try {
    const saved = previous
      ? await inventoryRequest<Omit<Product, "tone" | "initials">>(
          `/productos/${previous.id}`,
          {
            method: "PATCH",
            body: JSON.stringify(payload),
          },
        )
      : await inventoryRequest<Omit<Product, "tone" | "initials">>(
          "/productos",
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        );
    const updated = normalizedProduct(saved);
    form.reset();
    byId<HTMLDialogElement>("product-modal")?.close();
    await loadDashboardData();
    if (!previous && updated.variants[0]) {
      showBarcode(updated, updated.variants[0]);
    }
    notify(
      previous
        ? "Producto actualizado."
        : `Producto agregado con ${updated.variants.length} variante(s) y códigos generados.`,
    );
  } catch (cause) {
    notify(
      cause instanceof Error
        ? cause.message
        : "No se pudo guardar el producto.",
    );
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
});

byId("customer-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const customerId = Number(data.get("customerId")) || null;
  const previouslySelectedId = Number(
    byId<HTMLInputElement>("selected-customer-id")?.value,
  );
  const payload = {
    nombre: String(data.get("name") ?? "").trim(),
    telefono: String(data.get("phone") ?? "").trim(),
    cedula: String(data.get("cedula") ?? "").trim() || null,
    direccion: String(data.get("direccion") ?? "").trim() || null,
  };
  try {
    const customer = await inventoryRequest<{
      id: number;
      nombre: string;
      telefono: string;
      cedula: string | null;
      direccion: string | null;
    }>(customerId ? `/clientes/${customerId}` : "/clientes", {
      method: customerId ? "PATCH" : "POST",
      body: JSON.stringify(payload),
    });
    form.reset();
    byId<HTMLDialogElement>("customer-modal")?.close();
    await loadDashboardData();
    if (customerId) {
      if (previouslySelectedId === customerId) renderCustomers(customerId);
      notify("Cliente actualizado.");
    } else {
      renderCustomers(customer.id);
      notify("Cliente agregado y seleccionado para la venta.");
    }
  } catch (cause) {
    notify(
      cause instanceof Error ? cause.message : "No se pudo guardar el cliente.",
    );
  }
});

byId("movement-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const variantId = Number(data.get("variantId"));
  const quantity = Number(data.get("quantity"));
  const type = String(data.get("type")) as "Ingreso" | "Salida";
  const item = variantFor(variantId);
  if (!item || !Number.isInteger(quantity) || quantity < 1) {
    notify("Selecciona un producto con talla y una cantidad válida.");
    return;
  }
  try {
    await inventoryRequest("/movimientos", {
      method: "POST",
      body: JSON.stringify({
        varianteId: variantId,
        tipo: type,
        cantidad: quantity,
      }),
    });
    form.reset();
    byId<HTMLDialogElement>("movement-modal")?.close();
    await loadDashboardData();
    notify(`${type} de ${quantity} unidades registrado.`);
  } catch (cause) {
    notify(
      cause instanceof Error
        ? cause.message
        : "No se pudo registrar el movimiento.",
    );
  }
});

byId("product-category")?.addEventListener("change", () =>
  renderProductVariantFields(),
);
byId("product-sells-by-box")?.addEventListener("change", () =>
  renderProductVariantFields(),
);
byId<HTMLInputElement>("product-price")?.addEventListener(
  "input",
  (event) => {
    const basePrice = (event.currentTarget as HTMLInputElement).value;
    byId("product-size-prices")
      ?.querySelectorAll<HTMLInputElement>(
        '[data-size-price-default="true"]',
      )
      .forEach((input) => {
        input.value = basePrice;
      });
  },
);
byId("product-size-prices")?.addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.matches("[data-size-price]")) {
    target.dataset.sizePriceDefault = "false";
  }
});
byId("product-sizes")?.addEventListener("change", () =>
  renderProductVariantFields(),
);
byId("product-colors")?.addEventListener("change", () =>
  renderProductVariantFields(),
);

byId("talla-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const tallaId = Number(data.get("sizeId")) || null;
  const nombre = String(data.get("name") ?? "").trim();
  if (!nombre) return;
  const submitButton = byId<HTMLButtonElement>("save-size-button");
  if (submitButton) submitButton.disabled = true;
  try {
    await inventoryRequest(tallaId ? `/tallas/${tallaId}` : "/tallas", {
      method: tallaId ? "PATCH" : "POST",
      body: JSON.stringify({ nombre }),
    });
    await loadDashboardData();
    resetSizeForm();
    notify(tallaId ? "Talla actualizada." : `Talla ${nombre} agregada.`);
  } catch (cause) {
    notify(
      cause instanceof Error ? cause.message : "No se pudo guardar la talla.",
    );
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

byId("color-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const colorId = Number(data.get("colorId")) || null;
  const nombre = String(data.get("name") ?? "").trim();
  if (!nombre) return;
  const submitButton = byId<HTMLButtonElement>("save-color-button");
  if (submitButton) submitButton.disabled = true;
  try {
    await inventoryRequest(colorId ? `/colores/${colorId}` : "/colores", {
      method: colorId ? "PATCH" : "POST",
      body: JSON.stringify({ nombre }),
    });
    await loadDashboardData();
    resetColorForm();
    notify(colorId ? "Color actualizado." : `Color ${nombre} agregado.`);
  } catch (cause) {
    notify(
      cause instanceof Error ? cause.message : "No se pudo guardar el color.",
    );
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

byId("cancel-size-edit")?.addEventListener("click", resetSizeForm);
byId("cancel-color-edit")?.addEventListener("click", resetColorForm);

byId("product-search")?.addEventListener("input", renderProducts);
byId("category-filter")?.addEventListener("change", renderProducts);
byId("pos-search")?.addEventListener("input", renderPos);
byId("payment-method")?.addEventListener("change", renderCart);
byId("sale-discount")?.addEventListener("input", renderCart);
byId("initial-payment-amount")?.addEventListener("input", renderCart);
byId("customer-search")?.addEventListener("input", (event) => {
  renderCustomerResults((event.currentTarget as HTMLInputElement).value);
});
byId("customer-crud-search")?.addEventListener("input", renderCustomersTable);
byId("customer-search")?.addEventListener("focus", (event) => {
  renderCustomerResults((event.currentTarget as HTMLInputElement).value);
});
byId("customer-search")?.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    byId("customer-results")
      ?.querySelector<HTMLButtonElement>("[data-customer-select]")
      ?.focus();
    return;
  }
  if (event.key === "Enter") {
    const firstOption = byId(
      "customer-results",
    )?.querySelector<HTMLButtonElement>("[data-customer-select]");
    if (
      firstOption &&
      !byId("customer-results")?.classList.contains("hidden")
    ) {
      event.preventDefault();
      firstOption.click();
    }
    return;
  }
  if (event.key === "Escape") {
    byId("customer-results")?.classList.add("hidden");
    (event.currentTarget as HTMLInputElement).setAttribute(
      "aria-expanded",
      "false",
    );
  }
});
byId("history-search")?.addEventListener("input", renderSales);
byId("history-date-from")?.addEventListener("change", renderSales);
byId("history-date-to")?.addEventListener("change", renderSales);
byId("history-payment")?.addEventListener("change", renderSales);
byId("stats-date-from")?.addEventListener("change", renderSalesStats);
byId("stats-date-to")?.addEventListener("change", renderSalesStats);
byId("export-sales-csv")?.addEventListener("click", exportSalesCsv);
byId("clear-history-filters")?.addEventListener("click", () => {
  byId<HTMLInputElement>("history-search")!.value = "";
  byId<HTMLInputElement>("history-date-from")!.value = "";
  byId<HTMLInputElement>("history-date-to")!.value = "";
  byId<HTMLSelectElement>("history-payment")!.value = "";
  renderSales();
});
byId("barcode-input")?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const input = event.currentTarget as HTMLInputElement;
  scanBarcode(input.value);
  input.value = "";
});

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const closeButton = target.closest<HTMLElement>("[data-close]");
  if (closeButton) {
    byId<HTMLDialogElement>(closeButton.dataset.close ?? "")?.close();
    return;
  }
  const editSize = target.closest<HTMLElement>("[data-size-edit]");
  if (editSize) {
    const size = tallas.find(
      (item) => item.id === Number(editSize.dataset.sizeEdit),
    );
    if (!size) return;
    (byId<HTMLFormElement>("talla-form")!.elements.namedItem(
      "sizeId",
    ) as HTMLInputElement).value = String(size.id);
    byId<HTMLInputElement>("size-name")!.value = size.nombre;
    byId("size-form-label")!.textContent = "Editar talla";
    byId("save-size-button")!.textContent = "Guardar cambios";
    byId("cancel-size-edit")?.classList.remove("hidden");
    return;
  }
  const deleteSize = target.closest<HTMLElement>("[data-size-delete]");
  if (deleteSize) {
    const size = tallas.find(
      (item) => item.id === Number(deleteSize.dataset.sizeDelete),
    );
    if (!size || !window.confirm(`¿Eliminar la talla "${size.nombre}"?`)) {
      return;
    }
    try {
      await inventoryRequest(`/tallas/${size.id}`, { method: "DELETE" });
      resetSizeForm();
      await loadDashboardData();
      notify("Talla eliminada.");
    } catch (cause) {
      notify(
        cause instanceof Error ? cause.message : "No se pudo eliminar la talla.",
      );
    }
    return;
  }
  const editColor = target.closest<HTMLElement>("[data-color-edit]");
  if (editColor) {
    const color = colors.find(
      (item) => item.id === Number(editColor.dataset.colorEdit),
    );
    if (!color) return;
    (byId<HTMLFormElement>("color-form")!.elements.namedItem(
      "colorId",
    ) as HTMLInputElement).value = String(color.id);
    byId<HTMLInputElement>("color-name")!.value = color.nombre;
    byId("color-form-label")!.textContent = "Editar color";
    byId("save-color-button")!.textContent = "Guardar cambios";
    byId("cancel-color-edit")?.classList.remove("hidden");
    return;
  }
  const deleteColor = target.closest<HTMLElement>("[data-color-delete]");
  if (deleteColor) {
    const color = colors.find(
      (item) => item.id === Number(deleteColor.dataset.colorDelete),
    );
    if (!color || !window.confirm(`¿Eliminar el color "${color.nombre}"?`)) {
      return;
    }
    try {
      await inventoryRequest(`/colores/${color.id}`, { method: "DELETE" });
      resetColorForm();
      await loadDashboardData();
      notify("Color eliminado.");
    } catch (cause) {
      notify(
        cause instanceof Error ? cause.message : "No se pudo eliminar el color.",
      );
    }
    return;
  }
  const customerOption = target.closest<HTMLElement>("[data-customer-select]");
  if (customerOption) {
    const customer = customers.find(
      (item) => item.id === Number(customerOption.dataset.customerSelect),
    );
    if (customer) renderCustomers(customer.id);
    return;
  }
  const customerAccount = target.closest<HTMLElement>("[data-customer-account]");
  if (customerAccount) {
    await openCustomerAccount(Number(customerAccount.dataset.customerAccount));
    return;
  }
  const editCustomer = target.closest<HTMLElement>("[data-customer-edit]");
  if (editCustomer) {
    const customer = customers.find(
      (item) => item.id === Number(editCustomer.dataset.customerEdit),
    );
    if (customer) openCustomerForm(customer);
    return;
  }
  const deleteCustomer = target.closest<HTMLElement>("[data-customer-delete]");
  if (deleteCustomer) {
    const customer = customers.find(
      (item) => item.id === Number(deleteCustomer.dataset.customerDelete),
    );
    if (
      !customer ||
      !window.confirm(
        `¿Eliminar al cliente "${customer.name}"? No se podrá eliminar si tiene pedidos, pagos o ventas asociados.`,
      )
    ) {
      return;
    }
    try {
      await inventoryRequest(`/clientes/${customer.id}`, { method: "DELETE" });
      await loadDashboardData();
      notify("Cliente eliminado.");
    } catch (cause) {
      notify(
        cause instanceof Error
          ? cause.message
          : "No se pudo eliminar el cliente.",
      );
    }
    return;
  }
  if (!target.closest("#customer-picker")) {
    byId("customer-results")?.classList.add("hidden");
    byId("customer-search")?.setAttribute("aria-expanded", "false");
  }
  if (target.closest("#clear-selected-customer")) {
    const hidden = byId<HTMLInputElement>("selected-customer-id");
    if (hidden) hidden.value = "";
    const search = byId<HTMLInputElement>("customer-search");
    if (search) {
      search.value = "";
      search.classList.remove("hidden");
      search.focus();
    }
    byId("selected-customer")?.classList.add("hidden");
    renderCart();
    renderCustomerResults("");
    return;
  }
  const editCategory = target.closest<HTMLElement>("[data-category-edit]");
  if (editCategory) {
    const category = categories.find(
      (item) => item.id === Number(editCategory.dataset.categoryEdit),
    );
    if (!category) return;
    const form = byId<HTMLFormElement>("category-form");
    if (!form) return;
    (form.elements.namedItem("categoryId") as HTMLInputElement).value = String(
      category.id,
    );
    byId<HTMLInputElement>("category-name")!.value = category.nombre;
    byId("category-form-title")!.textContent = "Editar categoría";
    byId("save-category-button")!.textContent = "Guardar cambios";
    byId("cancel-category-edit")?.classList.remove("hidden");
    switchView("categories");
    byId<HTMLInputElement>("category-name")?.focus();
    return;
  }
  const deleteCategory = target.closest<HTMLElement>("[data-category-delete]");
  if (deleteCategory) {
    const id = Number(deleteCategory.dataset.categoryDelete);
    const category = categories.find((item) => item.id === id);
    if (
      !category ||
      !window.confirm(`¿Eliminar la categoría "${category.nombre}"?`)
    )
      return;
    try {
      await inventoryRequest(`/categorias/${id}`, { method: "DELETE" });
      await loadDashboardData();
      resetCategoryForm();
      notify("Categoría eliminada.");
    } catch (cause) {
      notify(
        cause instanceof Error
          ? cause.message
          : "No se pudo eliminar la categoría.",
      );
    }
    return;
  }
  const editUser = target.closest<HTMLElement>("[data-user-edit]");
  if (editUser) {
    const user = inventoryUsers.find(
      (item) => item.id === Number(editUser.dataset.userEdit),
    );
    const form = byId<HTMLFormElement>("inventory-user-form");
    if (!user || !form) return;
    (form.elements.namedItem("userId") as HTMLInputElement).value = String(
      user.id,
    );
    byId<HTMLInputElement>("inventory-user-name")!.value = user.username;
    byId<HTMLInputElement>("inventory-user-password")!.value = "";
    const password = byId<HTMLInputElement>("inventory-user-password");
    if (password) password.required = false;
    const role = form.elements.namedItem("rol") as HTMLSelectElement;
    role.value = user.rol;
    role.disabled = user.id === currentUser?.id;
    byId("inventory-user-form-title")!.textContent = "Editar usuario";
    byId("save-inventory-user-button")!.textContent = "Guardar cambios";
    byId("inventory-user-password-help")?.classList.remove("hidden");
    byId("cancel-inventory-user-edit")?.classList.remove("hidden");
    switchView("users");
    byId<HTMLInputElement>("inventory-user-name")?.focus();
    return;
  }
  const deleteUser = target.closest<HTMLElement>("[data-user-delete]");
  if (deleteUser) {
    const id = Number(deleteUser.dataset.userDelete);
    const user = inventoryUsers.find((item) => item.id === id);
    if (!user || user.id === currentUser?.id) return;
    if (!window.confirm(`¿Eliminar la cuenta "${user.username}"?`)) return;
    try {
      await inventoryRequest(`/usuarios/${id}`, { method: "DELETE" });
      await loadDashboardData();
      resetInventoryUserForm();
      notify("Usuario eliminado.");
    } catch (cause) {
      notify(
        cause instanceof Error
          ? cause.message
          : "No se pudo eliminar el usuario.",
      );
    }
    return;
  }
  const addStock = target.closest<HTMLElement>("[data-add-stock]");
  if (addStock) {
    openMovementFor(Number(addStock.dataset.addStock));
    return;
  }
  const editProduct = target.closest<HTMLElement>("[data-product-edit]");
  if (editProduct) {
    editProduct.closest("details")?.removeAttribute("open");
    openProductEditor(Number(editProduct.dataset.productEdit));
    return;
  }
  const deleteProduct = target.closest<HTMLElement>("[data-product-delete]");
  if (deleteProduct) {
    const id = Number(deleteProduct.dataset.productDelete);
    const product = productFor(id);
    if (!product) return;
    deleteProduct.closest("details")?.removeAttribute("open");
    pendingProductDeleteId = id;
    const name = byId("delete-product-name");
    if (name) name.textContent = product.name;
    byId<HTMLDialogElement>("delete-product-modal")?.showModal();
    return;
  }
  const confirmDeleteProduct = target.closest<HTMLElement>(
    "#confirm-delete-product",
  );
  if (confirmDeleteProduct) {
    const id = pendingProductDeleteId;
    const product = id === null ? undefined : productFor(id);
    if (!product) {
      byId<HTMLDialogElement>("delete-product-modal")?.close();
      pendingProductDeleteId = null;
      notify("No encontramos el producto que intentas eliminar.");
      return;
    }
    confirmDeleteProduct.setAttribute("aria-busy", "true");
    (confirmDeleteProduct as HTMLButtonElement).disabled = true;
    try {
      deletedProductSnapshots.set(product.id, product);
      await inventoryRequest(`/productos/${product.id}`, { method: "DELETE" });
      product.variants.forEach((variant) => {
        cart.delete(cartKey(variant.id, "UNIDAD"));
        cart.delete(cartKey(variant.id, "CAJA"));
      });
      await loadDashboardData();
      byId<HTMLDialogElement>("delete-product-modal")?.close();
      notify("Producto eliminado del catálogo.");
    } catch (cause) {
      notify(
        cause instanceof Error
          ? cause.message
          : "No se pudo eliminar el producto.",
      );
    } finally {
      pendingProductDeleteId = null;
      confirmDeleteProduct.removeAttribute("aria-busy");
      (confirmDeleteProduct as HTMLButtonElement).disabled = false;
    }
    return;
  }
  const variantBarcode = target.closest<HTMLElement>("[data-variant-barcode]");
  if (variantBarcode) {
    const item = variantFor(Number(variantBarcode.dataset.variantBarcode));
    if (item) showBarcode(item.product, item.variant);
    return;
  }
  const addToCart = target.closest<HTMLElement>("[data-cart-add]");
  if (addToCart) {
    addProductToCart(Number(addToCart.dataset.cartAdd));
    return;
  }
  const category = target.closest<HTMLElement>("[data-category]");
  if (category) {
    activeCategory = category.dataset.category ?? "Todas";
    renderPos();
    return;
  }
  const salePrint = target.closest<HTMLElement>("[data-sale-print]");
  if (salePrint) {
    const sale = sales.find((item) => item.id === salePrint.dataset.salePrint);
    if (sale) openSaleReceipt(sale);
    return;
  }
  const editSale = target.closest<HTMLElement>("[data-sale-edit]");
  if (editSale) {
    const sale = sales.find((item) => item.id === editSale.dataset.saleEdit);
    if (!sale) return;
    if (sale.payment === "Crédito") {
      notify("Las ventas a crédito no se pueden editar; revisa la cuenta del cliente.");
      return;
    }
    editingSaleId = sale.id;
    activeCategory = "Todas";
    byId<HTMLInputElement>("pos-search")!.value = "";
    editedProductSnapshots.clear();
    for (const item of sale.items) {
      const product = products.find((entry) => entry.id === item.productId);
      if (product?.variants.some((variant) => variant.id === item.variantId)) {
        continue;
      }
      const snapshot =
        product ??
        editedProductSnapshots.get(item.productId) ??
        normalizedProduct({
          id: item.productId,
          name: item.name,
          sku: "HISTORICO",
          barcode: "",
          categoryId: 0,
          category: "Producto no disponible",
          price: item.price,
          stock: 0,
          minStock: 0,
          unitsPerBox: null,
          boxPrice: null,
          variants: [],
        });
      snapshot.variants.push({
        id: item.variantId,
        tallaId: 0,
        colorId: null,
        size: item.size,
        color: null,
        sku: "HISTORICO",
        barcode: "",
        stock: 0,
        minStock: 0,
      });
      if (!product) editedProductSnapshots.set(item.productId, snapshot);
    }
    cart.clear();
    sale.items.forEach((item) =>
      cart.set(
        cartKey(item.variantId, item.presentation ?? "UNIDAD"),
        item.quantity,
      ),
    );
    renderCustomers(sale.customerId);
    const payment = byId<HTMLSelectElement>("payment-method");
    if (payment) payment.value = sale.payment;
    const discount = byId<HTMLInputElement>("sale-discount");
    if (discount) discount.value = String(sale.discountPercentage ?? 0);
    renderCart();
    switchView("pos", `Editar ${sale.id}`);
    return;
  }
});

byId("cart-items")?.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
    return;
  }
  const quantityInput = target.closest<HTMLInputElement>(
    "[data-cart-quantity]",
  );
  if (quantityInput) {
    const key = quantityInput.dataset.cartQuantity ?? "";
    const requested = Number(quantityInput.value);
    const { variantId, presentation } = parseCartKey(key);
    const item = variantFor(variantId);
    const maximum = item
      ? availableForCart(
          item.variant,
          presentationUnits(item.product, presentation),
          key,
        )
      : 0;
    if (!Number.isInteger(requested) || requested < 1 || requested > maximum) {
      notify(`Ingresa una cantidad entre 1 y ${maximum}.`);
      renderCart();
      return;
    }
    cart.set(key, requested);
    renderCart();
    return;
  }
  const presentationSelect = target.closest<HTMLSelectElement>(
    "[data-cart-presentation]",
  );
  if (!presentationSelect) return;
  const variantId = Number(presentationSelect.dataset.cartPresentation);
  const previous =
    presentationSelect.dataset.currentPresentation === "CAJA" ? "CAJA" : "UNIDAD";
  const next = presentationSelect.value === "CAJA" ? "CAJA" : "UNIDAD";
  const item = variantFor(variantId);
  const previousKey = cartKey(variantId, previous);
  const nextKey = cartKey(variantId, next);
  if (!item) return;
  const quantity = cart.get(previousKey) ?? 1;
  const mergedQuantity = quantity + (cart.get(nextKey) ?? 0);
  const maximum = availableForCart(
    item.variant,
    presentationUnits(item.product, next),
    [previousKey, nextKey],
  );
  if (mergedQuantity > maximum) {
    notify(
      `Solo hay stock para ${maximum} ${next === "CAJA" ? "caja(s)" : "unidad(es)"}.`,
    );
    renderCart();
    return;
  }
  cart.delete(previousKey);
  cart.set(nextKey, mergedQuantity);
  renderCart();
});

byId("clear-cart")?.addEventListener("click", () => {
  cart.clear();
  renderCart();
});

byId("toggle-cart")?.addEventListener("click", () => {
  const open = byId("sale-cart")?.classList.contains("is-open") ?? false;
  setMobileCartOpen(!open);
});

byId<HTMLButtonElement>("cart-backdrop")?.addEventListener("click", () => {
  setMobileCartOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setMobileCartOpen(false);
});

window.addEventListener("resize", () => {
  if (window.innerWidth >= 1280) setMobileCartOpen(false);
});

byId("cancel-edit-sale")?.addEventListener("click", () => {
  editingSaleId = null;
  editedProductSnapshots.clear();
  cart.clear();
  byId<HTMLInputElement>("sale-discount")!.value = "0";
  renderCustomers();
  switchView("pos");
});

async function confirmSale(pendingSale: Sale): Promise<void> {
  const currentCustomer = customers.find(
    (item) => item.id === pendingSale.customerId,
  );
  if (!currentCustomer) {
    byId<HTMLDialogElement>("sale-confirm-modal")?.close();
    notify("El cliente seleccionado ya no está disponible. Revisa la venta.");
    renderCustomers();
    return;
  }

  const quantitiesMatch =
    cart.size === pendingSale.items.length &&
    pendingSale.items.every(
      (item) =>
        cart.get(cartKey(item.variantId, item.presentation)) === item.quantity,
    );
  const stockAvailable = pendingSale.items.every((item) => {
    const product = variantFor(item.variantId);
    const key = cartKey(item.variantId, item.presentation);
    return (
      product &&
      availableForCart(
        product.variant,
        item.unitsPerPresentation,
        key,
      ) >= item.quantity
    );
  });
  if (!quantitiesMatch || !stockAvailable) {
    byId<HTMLDialogElement>("sale-confirm-modal")?.close();
    notify(
      "El carrito o las existencias cambiaron. Revisa los detalles antes de confirmar.",
    );
    renderPos();
    return;
  }

  let saleResponse: Omit<Sale, "date"> & { date: string | Date };
  try {
    saleResponse = await inventoryRequest<
      Omit<Sale, "date"> & { date: string | Date }
    >(editingSaleId ? `/ventas/${Number(editingSaleId.slice(2))}` : "/ventas", {
      method: editingSaleId ? "PATCH" : "POST",
      body: JSON.stringify({
        clienteId: pendingSale.customerId,
        metodoPago: pendingSale.payment,
        descuentoPorcentaje: pendingSale.discountPercentage,
        ...(pendingSale.payment === "Crédito"
          ? {
              abonoInicial: pendingSale.paid ?? 0,
              ...(pendingSale.paid && pendingSale.paid > 0
                ? { metodoAbonoInicial: pendingSale.paymentMethodInitial }
                : {}),
            }
          : {}),
        items: pendingSale.items.map((item) => ({
          varianteId: item.variantId,
          cantidad: item.quantity,
          presentacion: item.presentation,
        })),
      }),
    });
  } catch (cause) {
    byId<HTMLDialogElement>("sale-confirm-modal")?.close();
    notify(
      cause instanceof Error ? cause.message : "No se pudo registrar la venta.",
    );
    try {
      await loadDashboardData();
    } catch (refreshCause) {
      notify(
        refreshCause instanceof Error
          ? `No se pudo actualizar el inventario: ${refreshCause.message}`
          : "No se pudo actualizar el inventario.",
      );
    }
    return;
  }
  const sale: Sale = { ...saleResponse, date: new Date(saleResponse.date) };
  const wasEditing = editingSaleId !== null;
  editingSaleId = null;
  editedProductSnapshots.clear();
  cart.clear();
  byId<HTMLInputElement>("sale-discount")!.value = "0";
  byId<HTMLDialogElement>("sale-confirm-modal")?.close();
  try {
    await loadDashboardData();
  } catch (cause) {
    notify(
      cause instanceof Error
        ? `La venta quedó registrada, pero no se pudo actualizar la pantalla: ${cause.message}`
        : "La venta quedó registrada, pero no se pudo actualizar la pantalla.",
    );
  }
  showSaleReceipt(sale);
  switchView(wasEditing ? "sales" : "pos");
  notify(
    wasEditing
      ? `Venta ${sale.id} actualizada por ${currency.format(sale.total)}.`
      : `Venta ${sale.id} registrada por ${currency.format(sale.total)}.`,
  );
}

byId("complete-sale")?.addEventListener("click", () => {
  const customerId = Number(
    byId<HTMLInputElement>("selected-customer-id")?.value,
  );
  const customer = customers.find((item) => item.id === customerId);
  if (!customer) {
    notify("Busca y selecciona un cliente antes de completar la venta.");
    byId<HTMLInputElement>("customer-search")?.focus();
    return;
  }
  if (cart.size === 0) return;
  const items: SaleLine[] = [];
  for (const [key, quantity] of cart) {
    const { variantId, presentation } = parseCartKey(key);
    const item = variantFor(variantId);
    const unitsPerPresentation = item
      ? presentationUnits(item.product, presentation)
      : 0;
    if (
      !item ||
      quantity > availableForCart(item.variant, unitsPerPresentation, key)
    ) {
      notify("El stock cambió. Revisa las cantidades antes de cobrar.");
      renderPos();
      return;
    }
    items.push({
      productId: item.product.id,
      variantId: item.variant.id,
      size: variantLabel(item.variant),
      name: item.product.name,
      presentation,
      unitsPerPresentation,
      quantity,
      price: presentationPrice(
        item.product,
        presentation,
        item.variant,
      ),
    });
  }
  const subtotal = Math.round(items.reduce(
    (sum, item) => sum + item.quantity * item.price,
    0,
  ) * 100) / 100;
  const discountPercentage = Number(
    byId<HTMLInputElement>("sale-discount")?.value ?? 0,
  );
  if (
    !Number.isFinite(discountPercentage) ||
    discountPercentage < 0 ||
    discountPercentage > 100
  ) {
    notify("El descuento debe estar entre 0% y 100%.");
    return;
  }
  const discountAmount = Math.round(subtotal * discountPercentage) / 100;
  const total = Math.round((subtotal - discountAmount) * 100) / 100;
  const payment = byId<HTMLSelectElement>("payment-method")?.value ?? "Efectivo";
  const initialPayment =
    payment === "Crédito"
      ? Number(byId<HTMLInputElement>("initial-payment-amount")?.value ?? 0)
      : 0;
  if (
    !Number.isFinite(initialPayment) ||
    initialPayment < 0 ||
    initialPayment > total
  ) {
    notify("El abono inicial debe estar entre $0 y el total de la venta.");
    return;
  }
  if (payment === "Crédito" && editingSaleId) {
    notify("No se pueden convertir ventas existentes en ventas a crédito.");
    return;
  }
  const pendingSale: Sale = {
    id: "",
    date: new Date(),
    customerId: customer.id,
    customerName: customer.name,
    customerPhone: customer.phone,
    items,
    payment,
    subtotal,
    discountPercentage,
    discountAmount,
    total,
    paid: initialPayment,
    debt: payment === "Crédito" ? total - initialPayment : 0,
    paymentMethodInitial:
      byId<HTMLSelectElement>("initial-payment-method")?.value ?? "Efectivo",
  };
  showSaleConfirmation(pendingSale);
});

function refreshViews(): void {
  renderSummary();
  renderProducts();
  renderMovements();
  renderPos();
  renderSales();
}

async function initializeDashboard(): Promise<void> {
  const token = getInventoryToken();
  if (!token) {
    showLogin();
    return;
  }

  try {
    const result = await inventoryRequest<{
      success: true;
      usuario: InventoryUser;
    }>("/auth/perfil");
    setAuthenticatedView(result.usuario);
    await loadDashboardData();
  } catch (cause) {
    showLogin(
      cause instanceof Error
        ? `No se pudo conectar con el inventario: ${cause.message}`
        : "No se pudo validar la sesión de inventario.",
    );
  }
}

void initializeDashboard();
