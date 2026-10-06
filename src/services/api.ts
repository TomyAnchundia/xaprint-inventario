export interface InventoryUser {
  id: number;
  username: string;
  rol: "ADMIN" | "NORMAL";
}

const apiUrl = import.meta.env.PUBLIC_API_URL ?? "http://localhost:3000";
const tokenKey = "xaprint-inventario-token";
let pendingRequests = 0;
let requestStatusDialog: HTMLDialogElement | null = null;

function updateRequestStatus(delta: number): void {
  pendingRequests = Math.max(0, pendingRequests + delta);
  const status = document.getElementById("request-status");
  if (!status) return;
  if (pendingRequests > 0) {
    if (pendingRequests === 1) {
      requestStatusDialog = document.querySelector<HTMLDialogElement>(
        "dialog[open]",
      );
      if (requestStatusDialog) {
        const dialog = requestStatusDialog;
        dialog.append(status);
        status.classList.add("request-status--modal");
        dialog.addEventListener(
          "close",
          () => {
            if (requestStatusDialog !== dialog) return;
            document.body.append(status);
            status.classList.remove("request-status--modal");
            requestStatusDialog = null;
          },
          { once: true },
        );
      }
    }
    status.hidden = false;
  } else {
    status.hidden = true;
    document.body.append(status);
    status.classList.remove("request-status--modal");
    requestStatusDialog = null;
  }
}

export function getInventoryToken(): string | null {
  return localStorage.getItem(tokenKey);
}

export function clearInventoryToken(): void {
  localStorage.removeItem(tokenKey);
}

export function saveInventoryToken(token: string): void {
  localStorage.setItem(tokenKey, token);
}

export async function inventoryRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = getInventoryToken();
  updateRequestStatus(1);
  try {
    const response = await fetch(`${apiUrl}/inventario${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });

    if (response.status === 401) {
      clearInventoryToken();
      window.dispatchEvent(new Event("inventario:unauthorized"));
    }

    const payload: unknown = await response.json().catch(() => null);
    const errorPayload =
      payload && typeof payload === "object"
        ? (payload as { message?: unknown; success?: unknown })
        : null;
    if (!response.ok || errorPayload?.success === false) {
      const bodyMessage = errorPayload?.message;
      const message = Array.isArray(bodyMessage)
        ? bodyMessage.join(", ")
        : typeof bodyMessage === "string"
          ? bodyMessage
          : `Error de API (${response.status})`;
      throw new Error(message);
    }

    return payload as T;
  } finally {
    updateRequestStatus(-1);
  }
}

export async function loginInventory(
  username: string,
  password: string,
): Promise<{ token: string; usuario: InventoryUser }> {
  const result = await inventoryRequest<{
    success: true;
    token: string;
    usuario: InventoryUser;
  }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  saveInventoryToken(result.token);
  return result;
}
