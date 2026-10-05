# Xaprint Inventario

Aplicación de inventario y ventas conectada al backend NestJS y a la base de
datos Turso. Incluye catálogo, control de existencias, movimientos, punto de
venta, clientes, historial/estadísticas y comprobantes imprimibles o en PDF.

Los usuarios del inventario viven en `usuarios_inventario`, separados de los
usuarios del sistema principal. `ADMIN` puede acceder a todo; `NORMAL` puede
ver el resumen, registrar ventas y consultar el historial. Los permisos también
se comprueban en el backend. Cédula y dirección del cliente son opcionales.
Las categorías se administran desde la vista **Categorías** (solo `ADMIN`) y
los productos guardan una referencia a esa tabla.
La vista **Usuarios** permite al administrador crear cuentas, cambiar sus roles
y renovar contraseñas; no se permite eliminar la sesión propia, el último
administrador ni cuentas asociadas a ventas o movimientos. Las solicitudes al
backend muestran un indicador de espera, los diálogos quedan centrados y la
preferencia de modo oscuro se conserva en el navegador.
La vista **Clientes** permite buscar, crear, editar y eliminar clientes. La
eliminación se bloquea cuando hay pedidos, pagos o ventas asociados para
proteger el historial.
En **Productos** se pueden crear tallas reutilizables y asignarlas a cada
producto. Cada variante mantiene existencias, stock mínimo, SKU y código de
barras propios; las ventas, los escaneos y los movimientos descuentan o ajustan
la talla elegida. La migración inicial conserva los artículos anteriores como
variantes de talla **Única**.
Los productos pueden configurarse para venderse también por caja. El inventario
siempre se cuenta en unidades físicas: vender una caja descuenta las unidades
configuradas en ella y aplica el precio especial de caja. En el punto de venta,
la cantidad se puede ingresar numéricamente.
El método **Crédito** entrega los productos al confirmar la venta y registra el
saldo pendiente del cliente; antes de confirmar se puede registrar un abono
inicial. Desde **Clientes**, la cuenta muestra las ventas a crédito y el
historial de abonos, y permite registrar pagos posteriores, aplicados primero
a la deuda más antigua. Las ventas a crédito no se pueden editar para proteger
el historial de la deuda. La lista muestra por defecto solo cuentas con saldo
pendiente; el buscador encuentra cualquier cliente.
Los cambios de inventario se notifican por Socket.IO para que las sesiones
abiertas vuelvan a cargar existencias, ventas, clientes, deudas e historial sin
recargar la página. Al volver a una pestaña que estaba en segundo plano, también
se sincronizan los datos.
En **Historial de ventas** se pueden editar ventas no crediticias: cliente,
método de pago y productos/cantidades. El servidor recalcula el total y ajusta
el stock dentro de una transacción, registrando movimientos de corrección.

## Preparar la base de datos

Configura en `backend/.env` `JWT_SECRET`, `TURSO_AUTH_TOKEN` y una URL de Turso
en `TURSO_DATABASE_URL` o `TURSO_CONNECTION_URL`. Aplica todas las migraciones
pendientes, incluidas las de inventario, categorías, tallas, presentaciones por
caja y cuentas a crédito, a la misma base de datos configurada para el backend
antes de iniciar la aplicación:

```sh
pnpm --dir backend exec drizzle-kit migrate
```

Para crear la primera cuenta administradora de inventario:

1. Inicia sesión con una cuenta `ADMIN` del sistema principal en
   `POST /usuarios/login`.
2. Con el token obtenido, llama `POST /inventario/usuarios/bootstrap` con
   `Authorization: Bearer <token>` y el cuerpo
   `{"username":"admin-inventario","password":"una-clave-segura","rol":"ADMIN"}`.
   Esta ruta solo crea la cuenta inicial y no acepta tokens del inventario.
3. Las demás cuentas se crean desde una sesión administradora de inventario en
   `POST /inventario/usuarios`.

La etiqueta de producción se imprime desde el detalle de cada pedido del
sistema principal. El diálogo de impresión está preparado para papel de
80 × 80 mm (8 × 8 cm).

## Desarrollo

`frontend-inventario/.env` apunta el frontend al backend de la red local en
`http://192.168.3.125:3000`. Cambia `PUBLIC_API_URL` si la dirección del backend
cambia. Astro lee esta variable al iniciar y al compilar. Instala dependencias
desde la raíz del repositorio y ejecuta:

```sh
pnpm --dir backend start:dev
pnpm --dir frontend-inventario dev
```

La interfaz de inventario queda disponible en el puerto que indique Astro.

## Verificación

```sh
pnpm --dir backend build
pnpm --dir frontend-inventario typecheck
pnpm --dir frontend-inventario build
```
