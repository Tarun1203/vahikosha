// Who may do what in a business. The five roles of Vahikosha:
//   owner        the business owner: everything, including the team and settings
//   accountant   in-house accounts staff: day-to-day work and Tally sync;
//                approves entries only when the owner has allowed it
//   staff        sales, store, collections: records and dues, nothing else
//   outside_ca   the business's chartered accountant: reads the books, changes
//                nothing, and only for the period the owner chose
//   Chittam support is not a role inside a business: support staff are never
//   members, so they get no business data at all (see /api/support)

export type Role = "owner" | "accountant" | "staff" | "outside_ca";
export const ROLES: Role[] = ["owner", "accountant", "staff", "outside_ca"];

export type Action =
  | "records.read"     // customers, products, orders, service jobs, payments…
  | "records.write"
  | "tally.read"       // balances, bills, stock, vouchers from Tally
  | "tally.sync"       // read Tally now
  | "history.read"     // the activity log
  | "entries.approve"  // approve entries before they go to Tally
  | "team.manage"      // see and change who is in the business
  | "business.manage"; // modules, approval permission, business details

const TABLE: Record<Role, Action[]> = {
  owner: ["records.read", "records.write", "tally.read", "tally.sync", "history.read", "entries.approve", "team.manage", "business.manage"],
  accountant: ["records.read", "records.write", "tally.read", "tally.sync", "history.read", "entries.approve"],
  staff: ["records.read", "records.write", "tally.read"],
  outside_ca: ["records.read", "tally.read"],
};

export interface Membership {
  businessId: string;
  businessName: string;
  businessStatus: string;
  role: Role;
  accountantCanApprove: boolean;
  accessFrom: string | null;   // YYYY-MM-DD, outside CA only
  accessTo: string | null;
}

// can this member do this now?
export function can(m: Membership, action: Action, today = new Date().toISOString().slice(0, 10)): boolean {
  if (!usable(m, today)) return false;
  if (!TABLE[m.role]?.includes(action)) return false;
  if (action === "entries.approve" && m.role === "accountant") return m.accountantCanApprove;
  return true;
}

// a closed or suspended business, or an outside CA outside their period, gets nothing
export function usable(m: Membership, today = new Date().toISOString().slice(0, 10)): boolean {
  if (m.businessStatus !== "active") return false;
  if (m.accessFrom && today < m.accessFrom) return false;
  if (m.accessTo && today > m.accessTo) return false;
  return true;
}

export function permissions(m: Membership): Action[] {
  return (Object.keys(Object.fromEntries(Object.values(TABLE).flat().map((a) => [a, 1]))) as Action[]).filter((a) => can(m, a));
}

// ---------------------------------------------------------------- modules

export type Module = "orders" | "services" | "transports" | "catalog";
export const MODULES: Module[] = ["orders", "services", "transports", "catalog"];
export const MODULE_LABEL: Record<Module, string> = { orders: "Orders", services: "Service jobs", transports: "Transport", catalog: "Catalog" };

// the module a collection belongs to (collections not listed are always on)
export const COLLECTION_MODULE: Record<string, Module> = { orders: "orders", services: "services", transports: "transports", products: "catalog" };
