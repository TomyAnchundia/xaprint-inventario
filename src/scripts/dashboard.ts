import JsBarcode from "jsbarcode";
import { jsPDF } from "jspdf";
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
  stock: number;
  minStock: number;
  tone: string;
  initials: string;
}

interface Movement {
  id: number;
  productId: number;
  type: "Ingreso" | "Salida" | "Venta";
  quantity: number;
  date: Date;
  user: string;
  productName?: string;
}

interface SaleLine {
  productId: number;
  name: string;
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
  total: number;
}

interface Customer {
  id: number;
  name: string;
  phone: string;
  cedula?: string | null;
  direccion?: string | null;
}

interface ManagedInventoryUser extends InventoryUser {
  createdAt: string | Date;
}

const products: Product[] = [];
const customers: Customer[] = [];
const movements: Movement[] = [];
const sales: Sale[] = [];
const categories: Array<{ id: number; nombre: string }> = [];
const inventoryUsers: ManagedInventoryUser[] = [];

const cart = new Map<number, number>();
const deletedProductSnapshots = new Map<number, Product>();
const editedProductSnapshots = new Map<number, Product>();
let activeCategory = "Todas";
let toastTimeout = 0;
let currentUser: InventoryUser | null = null;
let editingSaleId: string | null = null;
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
  window.clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.classList.remove("translate-y-[-8px]", "opacity-0");
  toast.classList.add("translate-y-0", "opacity-100");
  toastTimeout = window.setTimeout(() => {
    toast.classList.add("translate-y-[-8px]", "opacity-0");
    toast.classList.remove("translate-y-0", "opacity-100");
  }, 2600);
}

function setAuthenticatedView(user: InventoryUser): void {
  currentUser = user;
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
    usuariosApi,
  ] = await Promise.all([
    inventoryRequest<
      Array<{
        id: number;
        nombre: string;
        telefono: string;
        cedula?: string | null;
        direccion?: string | null;
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
  inventoryUsers.splice(0, inventoryUsers.length, ...usuariosApi);
  renderCategoryOptions();
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
  const lowStock = products.filter(
    (product) => product.stock <= product.minStock,
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
          <div class="min-w-0 flex-1"><p class="truncate text-xs font-semibold text-slate-700">${escapeHtml(product.name)}</p><p class="mt-1 text-[10px] text-slate-400">Mínimo ${product.minStock} unidades</p></div>
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
      <td><div class="flex items-center gap-3"><span class="hidden h-8 w-8 items-center justify-center rounded-lg ${product.tone} text-[10px] font-bold sm:flex">${escapeHtml(product.initials)}</span><span class="font-semibold text-slate-700">${escapeHtml(product.name)}</span></div></td>
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
            <button type="button" class="text-xs font-semibold text-[#287052] hover:underline" data-category-edit="${category.id}">Editar</button>
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
            <button type="button" class="text-xs font-semibold text-[#287052] hover:underline" data-user-edit="${user.id}">Editar</button>
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
  const filtered = customers.filter((customer) =>
    `${customer.name} ${customer.phone} ${customer.cedula ?? ""} ${customer.direccion ?? ""}`
      .toLocaleLowerCase("es")
      .includes(query),
  );
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
          <td class="text-right">
            <div class="flex justify-end gap-2">
              <button type="button" class="text-xs font-semibold text-[#287052] hover:underline" data-customer-edit="${customer.id}">Editar</button>
              <button type="button" class="text-xs font-semibold text-rose-600 hover:underline" data-customer-delete="${customer.id}">Eliminar</button>
            </div>
          </td>
        </tr>`,
        )
        .join("") || emptyRow("No se encontraron clientes.", 5);
  }
  byId("customers-crud-empty")?.classList.toggle("hidden", filtered.length > 0);
  const count = byId("customer-crud-count");
  if (count) {
    count.textContent = `${filtered.length} de ${customers.length} ${
      customers.length === 1 ? "cliente" : "clientes"
    }`;
  }
}

function renderProducts(): void {
  const search =
    byId<HTMLInputElement>("product-search")?.value.trim().toLowerCase() ?? "";
  const category = byId<HTMLSelectElement>("category-filter")?.value ?? "";
  const filtered = [...products, ...editedProductSnapshots.values()].filter(
    (product) =>
      `${product.name} ${product.sku} ${product.barcode}`
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
          const low = product.stock <= product.minStock;
          const out = product.stock === 0;
          return `<tr>
      <td><div class="flex items-center gap-3"><span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${product.tone} text-[10px] font-bold">${escapeHtml(product.initials)}</span><span class="font-semibold text-slate-700">${escapeHtml(product.name)}</span></div></td>
      <td class="font-mono text-xs text-slate-400">${escapeHtml(product.sku)}</td>
      <td><button class="text-left font-mono text-[10px] text-[#287052] hover:underline" data-product-barcode="${product.id}" title="Ver código de barras">${escapeHtml(product.barcode)}</button></td>
      <td class="text-slate-500">${escapeHtml(product.category)}</td>
      <td class="font-semibold text-slate-700">${currency.format(product.price)}</td>
      <td><span class="font-semibold ${low ? "text-rose-700" : "text-slate-700"}">${product.stock}</span><span class="ml-1 text-[10px] text-slate-400">uds.</span></td>
      <td><span class="rounded-full px-2.5 py-1 text-[10px] font-bold ${out ? "bg-slate-100 text-slate-500" : low ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}">${out ? "Agotado" : low ? "Stock bajo" : "Disponible"}</span></td>
      <td class="text-right">
        <div class="flex items-center justify-end gap-1">
          <button class="rounded-lg px-2 py-1 text-xs font-semibold text-[#287052] hover:bg-emerald-50" data-add-stock="${product.id}">＋ Stock</button>
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
  const filtered = products.filter(
    (product) =>
      availableForSale(product, editedSale) > 0 &&
      `${product.name} ${product.sku} ${product.barcode}`
        .toLowerCase()
        .includes(search) &&
      (activeCategory === "Todas" || product.category === activeCategory),
  );
  const container = byId("pos-products");
  if (container)
    container.innerHTML = filtered
      .map(
        (product) => `
    <button class="product-tile group text-left" data-cart-add="${product.id}">
      <div class="flex h-28 items-center justify-center rounded-xl ${product.tone} transition group-hover:brightness-[0.98]">
        <span class="text-2xl font-black tracking-wide opacity-70">${escapeHtml(product.initials)}</span>
      </div>
      <div class="mt-3 flex items-start justify-between gap-2">
        <div class="min-w-0"><p class="truncate text-xs font-semibold text-slate-700">${escapeHtml(product.name)}</p><p class="mt-1 text-[10px] text-slate-400">${availableForSale(product, editedSale)} disponibles</p></div>
        <span class="shrink-0 text-xs font-bold text-[#1e6047]">${currency.format(product.price)}</span>
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
    .map(([id, quantity]) => ({ product: productFor(id), quantity }))
    .filter((entry) => entry.product);
  const items = byId("cart-items");
  const itemCount = entries.reduce((total, entry) => total + entry.quantity, 0);
  const total = entries.reduce(
    (sum, entry) => sum + entry.product!.price * entry.quantity,
    0,
  );
  if (items)
    items.innerHTML = entries
      .map(
        ({ product, quantity }) => `
    <div class="flex items-center gap-3 py-4">
      <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${product!.tone} text-[10px] font-bold">${escapeHtml(product!.initials)}</div>
      <div class="min-w-0 flex-1"><p class="truncate text-xs font-semibold text-slate-700">${escapeHtml(product!.name)}</p><p class="mt-1 text-[10px] text-slate-400">${currency.format(product!.price)}</p></div>
      <div class="flex items-center gap-1.5">
        <button class="qty-button" data-cart-change="${product!.id}" data-delta="-1" aria-label="Quitar uno">−</button>
        <span class="w-5 text-center text-xs font-semibold">${quantity}</span>
        <button class="qty-button" data-cart-change="${product!.id}" data-delta="1" aria-label="Agregar uno" ${
          quantity >=
          availableForSale(
            product!,
            sales.find((sale) => sale.id === editingSaleId),
          )
            ? "disabled"
            : ""
        }>＋</button>
      </div>
    </div>`,
      )
      .join("");
  byId("cart-count")!.textContent = String(itemCount);
  byId("cart-subtotal")!.textContent = currency.format(total);
  byId("cart-total")!.textContent = currency.format(total);
  byId("cart-empty")?.classList.toggle("hidden", entries.length > 0);
  const hasCustomer = Boolean(
    byId<HTMLInputElement>("selected-customer-id")?.value,
  );
  const completeButton = byId<HTMLButtonElement>("complete-sale");
  if (completeButton) {
    completeButton.disabled = entries.length === 0 || !hasCustomer;
    completeButton.textContent = editingSaleId
      ? "Guardar cambios de venta"
      : "Completar venta";
  }
  const requirements = byId("sale-requirements");
  if (requirements) {
    requirements.textContent = !hasCustomer
      ? "Selecciona un cliente para completar la venta."
      : entries.length === 0
        ? "Agrega productos para continuar."
        : editingSaleId
          ? "Las existencias se ajustarán al guardar los cambios."
          : "El stock se actualizará al confirmar la venta.";
  }
}

function availableForSale(product: Product, sale?: Sale): number {
  const returned =
    sale?.items
      .filter((item) => item.productId === product.id)
      .reduce((sum, item) => sum + item.quantity, 0) ?? 0;
  return product.stock + returned;
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
            ...sale.items.map((item) => item.name),
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
      <td class="font-mono text-xs font-semibold text-[#287052]">${escapeHtml(sale.id)}</td>
      <td class="font-medium text-slate-700">${escapeHtml(sale.customerName)}</td>
      <td class="text-xs text-slate-500">${dateTime.format(sale.date)}</td>
      <td class="text-slate-600">${sale.items.reduce((sum, item) => sum + item.quantity, 0)} artículos</td>
      <td><span class="rounded-md bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-600">${escapeHtml(sale.payment)}</span></td>
      <td class="text-right font-bold text-slate-700">${currency.format(sale.total)}</td>
      <td>
        <div class="flex items-center justify-end gap-1">
          <button class="sale-action" data-sale-edit="${escapeHtml(sale.id)}">Editar</button>
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
      const product = productMap.get(item.name) ?? {
        name: item.name,
        quantity: 0,
        total: 0,
      };
      product.quantity += item.quantity;
      product.total += item.quantity * item.price;
      productMap.set(item.name, product);
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
            ...sale.items.map((item) => item.name),
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
    "Total",
  ];
  const rows = filtered.map((sale) => [
    sale.id,
    sale.date.toLocaleString("sv-SE"),
    sale.customerName,
    sale.customerPhone ?? "",
    sale.payment,
    sale.items.map((item) => `${item.name} x${item.quantity}`).join(" | "),
    sale.items.reduce((sum, item) => sum + item.quantity, 0),
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
          <span>${escapeHtml(item.name)}<small>${currency.format(item.price)} c/u</small></span>
          <span>${item.quantity}</span>
          <strong>${currency.format(item.quantity * item.price)}</strong>
        </div>`,
        )
        .join("")}
    </div>
    <div class="receipt-total"><span>Total</span><strong>${currency.format(sale.total)}</strong></div>
    <p class="receipt-thanks">Gracias por tu compra</p>`;
}

function showSaleConfirmation(sale: Sale): void {
  const content = byId("sale-confirm-content");
  const dialog = byId<HTMLDialogElement>("sale-confirm-modal");
  if (!content || !dialog) return;
  const itemCount = sale.items.reduce((sum, item) => sum + item.quantity, 0);
  const editing = editingSaleId !== null;
  content.innerHTML = `
    <div class="modal-heading">
      <div><h2 class="text-lg font-bold">${editing ? `Guardar cambios de ${escapeHtml(editingSaleId!)}` : "Confirmar venta"}</h2><p class="mt-1 text-xs text-slate-500">${editing ? "Revisa los cambios antes de actualizar la venta." : "Revisa los detalles antes de confirmar el cobro."}</p></div>
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
          ${sale.items.map((item) => `<div class="flex items-center justify-between gap-4 py-3 text-sm"><span class="min-w-0"><span class="font-semibold text-slate-700">${escapeHtml(item.name)}</span><span class="ml-2 text-xs text-slate-400">× ${item.quantity}</span></span><span class="shrink-0 font-semibold text-slate-700">${currency.format(item.quantity * item.price)}</span></div>`).join("")}
        </div>
        <div class="flex items-center justify-between border-t border-[#edf0ec] bg-[#fafbf9] px-4 py-4"><span class="text-sm font-bold text-slate-600">Total</span><strong class="text-lg font-bold text-[#1d5d43]">${currency.format(sale.total)}</strong></div>
      </div>
      <p class="text-xs text-slate-400">${editing ? "Al guardar, se actualizarán la venta y las existencias." : "Al confirmar, se registrará la venta y se actualizarán las existencias."}</p>
    </div>
    <div class="flex justify-end gap-2 border-t border-[#edf0ec] p-4">
      <button type="button" class="secondary-button" data-close="sale-confirm-modal">Volver a la venta</button>
      <button type="button" id="confirm-sale-button" class="primary-button">${editing ? "Guardar cambios" : "Confirmar venta"} · ${currency.format(sale.total)}</button>
    </div>`;
  byId("confirm-sale-button")?.addEventListener("click", () =>
    confirmSale(sale),
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
    const nameLines = pdf.splitTextToSize(item.name, contentWidth - 75);
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

function openMovementFor(productId?: number): void {
  const select = byId<HTMLSelectElement>("movement-product");
  const dialog = byId<HTMLDialogElement>("movement-modal");
  if (!select || !dialog) return;
  select.innerHTML = products
    .map(
      (product) =>
        `<option value="${product.id}">${escapeHtml(product.name)} · ${product.stock} uds.</option>`,
    )
    .join("");
  if (productId) select.value = String(productId);
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

function showBarcode(product: Product): void {
  const content = byId("barcode-content");
  const dialog = byId<HTMLDialogElement>("barcode-modal");
  if (!content || !dialog) return;
  content.innerHTML = `
    <div class="modal-heading"><div><h2 class="text-lg font-bold">Código de barras</h2><p class="mt-1 text-xs text-slate-500">${escapeHtml(product.name)} · ${escapeHtml(product.sku)}</p></div><button type="button" class="modal-close" data-close="barcode-modal" aria-label="Cerrar">✕</button></div>
    <div class="barcode-preview"><svg id="barcode-svg" role="img" aria-label="Código de barras ${escapeHtml(product.barcode)}"></svg></div>
    <p class="pb-5 text-center font-mono text-xs tracking-wider text-slate-500">${escapeHtml(product.barcode)}</p>
    <div class="flex justify-end gap-2 border-t border-[#edf0ec] p-4"><button type="button" class="secondary-button" data-close="barcode-modal">Cerrar</button><button type="button" id="print-barcode" class="primary-button">Imprimir código</button></div>`;
  const svg = byId<SVGSVGElement>("barcode-svg");
  if (svg) {
    JsBarcode(svg, product.barcode, {
      format: "CODE128",
      displayValue: false,
      height: 70,
      margin: 8,
      background: "#ffffff",
      lineColor: "#173d32",
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
  data.set("name", product.name);
  data.set("price", String(product.price));
  data.set("stock", String(product.stock));
  data.set("minStock", String(product.minStock));
  form.reset();
  renderCategoryOptions(product.categoryId);
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
  const skuDisplay = byId<HTMLInputElement>("product-sku-display");
  if (skuDisplay) skuDisplay.value = "Se asignará al guardar";
  byId("product-modal-title")!.textContent = "Nuevo producto";
  byId("save-product-button")!.textContent = "Guardar producto";
  byId<HTMLDialogElement>("product-modal")?.showModal();
}

function addProductToCart(product: Product): void {
  const quantity = cart.get(product.id) ?? 0;
  if (
    quantity >=
    availableForSale(
      product,
      sales.find((sale) => sale.id === editingSaleId),
    )
  ) {
    notify("No hay existencias suficientes para agregar otra unidad.");
    return;
  }
  cart.set(product.id, quantity + 1);
  renderCart();
}

function scanBarcode(value: string): void {
  const code = value.trim().toUpperCase();
  if (!code) return;
  const product = products.find(
    (item) =>
      item.barcode.toUpperCase() === code || item.sku.toUpperCase() === code,
  );
  if (!product) {
    notify(`No encontramos un producto con el código ${code}.`);
  } else if (product.stock < 1) {
    notify(`${product.name} no tiene existencias.`);
  } else {
    addProductToCart(product);
    byId<HTMLInputElement>("barcode-input")?.focus();
  }
}

function switchView(view: string, title?: string): void {
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

byId("open-sidebar")?.addEventListener("click", () => {
  byId("sidebar")?.classList.remove("-translate-x-full");
  byId("sidebar-scrim")?.classList.remove("hidden");
});
byId("close-sidebar")?.addEventListener("click", closeSidebar);
byId("sidebar-scrim")?.addEventListener("click", closeSidebar);

byId("open-product-modal")?.addEventListener("click", openNewProductForm);
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
  const stock = Number(data.get("stock"));
  const previous = productId ? productFor(productId) : undefined;
  if (productId && !previous) {
    notify("No encontramos el producto que intentas editar.");
    return;
  }
  const payload = {
    nombre: name,
    categoriaId: categoryId,
    precio: Number(data.get("price")),
    existencia: stock,
    stockMinimo: Number(data.get("minStock")),
  };
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
    if (!previous) showBarcode(updated);
    notify(
      previous
        ? "Producto actualizado."
        : `Producto agregado. Código ${updated.barcode} generado.`,
    );
  } catch (cause) {
    notify(
      cause instanceof Error
        ? cause.message
        : "No se pudo guardar el producto.",
    );
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
  const productId = Number(data.get("productId"));
  const quantity = Number(data.get("quantity"));
  const type = String(data.get("type")) as "Ingreso" | "Salida";
  const product = productFor(productId);
  if (!product || !Number.isInteger(quantity) || quantity < 1) {
    notify("Selecciona un producto y una cantidad válida.");
    return;
  }
  try {
    await inventoryRequest("/movimientos", {
      method: "POST",
      body: JSON.stringify({
        productoId: productId,
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

byId("product-search")?.addEventListener("input", renderProducts);
byId("category-filter")?.addEventListener("change", renderProducts);
byId("pos-search")?.addEventListener("input", renderPos);
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
  const customerOption = target.closest<HTMLElement>("[data-customer-select]");
  if (customerOption) {
    const customer = customers.find(
      (item) => item.id === Number(customerOption.dataset.customerSelect),
    );
    if (customer) renderCustomers(customer.id);
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
    if (
      !window.confirm(
        `¿Eliminar "${product.name}" del catálogo? Sus ventas y movimientos anteriores se conservarán.`,
      )
    )
      return;
    try {
      deletedProductSnapshots.set(id, product);
      await inventoryRequest(`/productos/${id}`, { method: "DELETE" });
      cart.delete(id);
      await loadDashboardData();
      notify("Producto eliminado del catálogo.");
    } catch (cause) {
      notify(
        cause instanceof Error
          ? cause.message
          : "No se pudo eliminar el producto.",
      );
    }
    return;
  }
  const productBarcode = target.closest<HTMLElement>("[data-product-barcode]");
  if (productBarcode) {
    const product = productFor(Number(productBarcode.dataset.productBarcode));
    if (product) showBarcode(product);
    return;
  }
  const addToCart = target.closest<HTMLElement>("[data-cart-add]");
  if (addToCart) {
    const id = Number(addToCart.dataset.cartAdd);
    const product = productFor(id);
    const quantity = cart.get(id) ?? 0;
    if (
      product &&
      quantity <
        availableForSale(
          product,
          sales.find((sale) => sale.id === editingSaleId),
        )
    ) {
      cart.set(id, quantity + 1);
      renderCart();
    }
    return;
  }
  const changeQuantity = target.closest<HTMLElement>("[data-cart-change]");
  if (changeQuantity) {
    const id = Number(changeQuantity.dataset.cartChange);
    const next = (cart.get(id) ?? 0) + Number(changeQuantity.dataset.delta);
    const product = productFor(id);
    if (next <= 0) cart.delete(id);
    else if (
      product &&
      next <=
        availableForSale(
          product,
          sales.find((sale) => sale.id === editingSaleId),
        )
    )
      cart.set(id, next);
    renderCart();
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
    editingSaleId = sale.id;
    activeCategory = "Todas";
    byId<HTMLInputElement>("pos-search")!.value = "";
    editedProductSnapshots.clear();
    for (const item of sale.items) {
      if (products.some((product) => product.id === item.productId)) continue;
      editedProductSnapshots.set(
        item.productId,
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
        }),
      );
    }
    cart.clear();
    sale.items.forEach((item) => cart.set(item.productId, item.quantity));
    renderCustomers(sale.customerId);
    const payment = byId<HTMLSelectElement>("payment-method");
    if (payment) payment.value = sale.payment;
    switchView("pos", `Editar ${sale.id}`);
    return;
  }
});

byId("clear-cart")?.addEventListener("click", () => {
  cart.clear();
  renderCart();
});

byId("cancel-edit-sale")?.addEventListener("click", () => {
  editingSaleId = null;
  editedProductSnapshots.clear();
  cart.clear();
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
      (item) => cart.get(item.productId) === item.quantity,
    );
  const stockAvailable = pendingSale.items.every((item) => {
    const product = productFor(item.productId);
    return (
      product &&
      availableForSale(
        product,
        sales.find((sale) => sale.id === editingSaleId),
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
        items: pendingSale.items.map((item) => ({
          productoId: item.productId,
          cantidad: item.quantity,
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
  for (const [id, quantity] of cart) {
    const product = productFor(id);
    if (
      !product ||
      quantity >
        availableForSale(
          product,
          sales.find((sale) => sale.id === editingSaleId),
        )
    ) {
      notify("El stock cambió. Revisa las cantidades antes de cobrar.");
      renderPos();
      return;
    }
    items.push({
      productId: product.id,
      name: product.name,
      quantity,
      price: product.price,
    });
  }
  const total = items.reduce(
    (sum, item) => sum + item.quantity * item.price,
    0,
  );
  const pendingSale: Sale = {
    id: "",
    date: new Date(),
    customerId: customer.id,
    customerName: customer.name,
    customerPhone: customer.phone,
    items,
    payment: byId<HTMLSelectElement>("payment-method")?.value ?? "Efectivo",
    total,
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
