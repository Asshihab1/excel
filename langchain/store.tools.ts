import { Injectable } from '@nestjs/common';
import { PrismaService } from '@prisma/prisma.service';
import { z } from 'zod';
import { serializeBigInt } from '@module/langchain/langchain.util';

export interface StoreTool {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: (args: any) => Promise<any>;
}

const PRODUCT_SELECT = {
  id: true,
  item_code: true,
  product_name: true,
  model_number: true,
  rack_no: true,
  current_stock: true,
  minimum_stock: true,
  unit_price: true,
  is_active: true,
  item_categories: { select: { name: true } },
  uoms: { select: { name: true } },
} as const;

@Injectable()
export class StoreToolsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Items / Inventory ──────────────────────────────────────────────────

  async getProducts(opts: {
    name?: string;
    item_code?: string;
    category?: string;
    is_active?: boolean;
    limit?: number;
  } = {}): Promise<any[]> {
    const where: Record<string, any> = {};
    if (opts.name) where.product_name = { contains: opts.name };
    if (opts.item_code) where.item_code = { contains: opts.item_code };
    if (opts.category) where.item_categories = { name: { contains: opts.category } };
    if (opts.is_active !== undefined) where.is_active = opts.is_active;

    const rows = await this.prisma.products.findMany({
      where,
      select: PRODUCT_SELECT,
      take: opts.limit ?? 50,
      orderBy: { product_name: 'asc' },
    });
    return serializeBigInt(rows);
  }

  async getProductByName(name: string): Promise<any | null> {
    const row = await this.prisma.products.findFirst({
      where: {
        OR: [
          { product_name: { contains: name } },
          { item_code: { contains: name } },
          { model_number: { contains: name } },
        ],
      },
      select: PRODUCT_SELECT,
    });
    return serializeBigInt(row);
  }

  // current_stock is a nullable VARCHAR column (legacy schema — see
  // Backend/database/migrations/2025_10_19_113322_add_rack_to_products_table),
  // NOT an integer, so it can't be compared to minimum_stock (an actual int
  // column) via a Prisma `lt` filter — Prisma has no column-to-column
  // comparison operator short of raw SQL. Same constraint the Laravel
  // LowStockController hit (it uses whereColumn + MySQL's implicit numeric
  // cast on the raw query). Mirrors that: fetch active products with a
  // parseable stock value and filter/sort in JS. Same base rule as the
  // Laravel endpoint: current_stock >= 0 AND current_stock < minimum_stock
  // (out-of-stock counts as low stock as long as a minimum is actually set;
  // the 0/0 case and negative-stock anomalies are excluded).
  async getLowStockProducts(opts: { limit?: number } = {}): Promise<any[]> {
    const candidates = await this.prisma.products.findMany({
      where: { is_active: true, minimum_stock: { gt: 0 } },
      select: PRODUCT_SELECT,
    });
    const low = candidates
      .map((p) => ({ ...p, _stock: Number(p.current_stock) }))
      .filter((p) => Number.isFinite(p._stock) && p._stock >= 0 && p._stock < p.minimum_stock)
      .sort((a, b) => a._stock - b._stock)
      .slice(0, opts.limit ?? 50)
      .map(({ _stock, ...rest }) => rest);
    return serializeBigInt(low);
  }

  async getLowStockCount(): Promise<{ low_stock_count: number }> {
    const candidates = await this.prisma.products.findMany({
      where: { is_active: true, minimum_stock: { gt: 0 } },
      select: { current_stock: true, minimum_stock: true },
    });
    const count = candidates.filter((p) => {
      const stock = Number(p.current_stock);
      return Number.isFinite(stock) && stock >= 0 && stock < p.minimum_stock;
    }).length;
    return { low_stock_count: count };
  }

  async getItemCategories(): Promise<any[]> {
    const rows = await this.prisma.item_categories.findMany({
      where: { is_active: true },
      select: { id: true, name: true, prefix: true },
      orderBy: { name: 'asc' },
    });
    return serializeBigInt(rows);
  }

  async getIdleInventory(opts: { condition?: string; limit?: number } = {}): Promise<any[]> {
    const where: Record<string, any> = {};
    if (opts.condition) where.condition = { contains: opts.condition };

    const rows = await this.prisma.idle_inventory_items.findMany({
      where,
      select: {
        id: true,
        custom_id: true,
        quantity: true,
        condition: true,
        remarks: true,
        created_date: true,
        expiry_date: true,
        products: { select: { product_name: true, item_code: true } },
      },
      take: opts.limit ?? 50,
      orderBy: { created_date: 'desc' },
    });
    return serializeBigInt(rows);
  }

  // ─── Purchase Requisitions (Indent/SPR & SR) ────────────────────────────

  // `type` distinguishes Indent/SPR (store → purchase dept request) from SR
  // (Store Requisition — issued from existing stock). `status` follows the
  // two-level approval flow: SUBMITTED → APPROVED (GM/level-1) →
  // FINAL_APPROVAL (level-2, stock actually decremented) / REJECTED.
  async getPurchaseRequisitions(opts: {
    type?: 'SPR' | 'SR';
    status?: 'SUBMITTED' | 'APPROVED' | 'FINAL_APPROVAL' | 'REJECTED';
    urgency?: string;
    department?: string;
    requested_by_name?: string;
    limit?: number;
  } = {}): Promise<any[]> {
    const where: Record<string, any> = {};
    if (opts.type) where.type = opts.type;
    if (opts.status) where.status = opts.status;
    if (opts.urgency) where.urgency = { contains: opts.urgency };
    if (opts.department) where.departments = { name: { contains: opts.department } };
    if (opts.requested_by_name) {
      where.users_purchase_requisitions_requested_byTousers = { name: { contains: opts.requested_by_name } };
    }

    const rows = await this.prisma.purchase_requisitions.findMany({
      where,
      select: {
        id: true,
        custom_id: true,
        type: true,
        status: true,
        urgency: true,
        request_date: true,
        required_by: true,
        is_imported: true,
        is_complete: true,
        estimated_cost: true,
        departments: { select: { name: true } },
        users_purchase_requisitions_requested_byTousers: { select: { name: true } },
      },
      take: opts.limit ?? 50,
      orderBy: { created_at: 'desc' },
    });
    return serializeBigInt(rows);
  }

  async getPurchaseRequisitionStatusBreakdown(opts: { type?: 'SPR' | 'SR' } = {}): Promise<any[]> {
    const grouped = await this.prisma.purchase_requisitions.groupBy({
      by: ['status'],
      where: opts.type ? { type: opts.type } : {},
      _count: { _all: true },
    });
    return grouped.map((g) => ({ status: g.status, count: g._count._all }));
  }

  // ─── Purchase Orders ─────────────────────────────────────────────────────

  async getPurchaseOrders(opts: {
    status?: 'PENDING' | 'APPROVED' | 'CANCELED' | 'RECEIVED';
    supplier_name?: string;
    is_imported?: boolean;
    limit?: number;
  } = {}): Promise<any[]> {
    const where: Record<string, any> = {};
    if (opts.status) where.status = opts.status;
    if (opts.is_imported !== undefined) where.is_imported = opts.is_imported;
    if (opts.supplier_name) where.suppliers = { name: { contains: opts.supplier_name } };

    const rows = await this.prisma.purchase_orders.findMany({
      where,
      select: {
        id: true,
        custom_id: true,
        status: true,
        is_imported: true,
        is_complete: true,
        po_date: true,
        total_amount: true,
        suppliers: { select: { name: true } },
      },
      take: opts.limit ?? 50,
      orderBy: { created_at: 'desc' },
    });
    return serializeBigInt(rows);
  }

  async getPendingPurchaseOrdersCount(): Promise<{ pending_purchase_orders: number }> {
    const pending_purchase_orders = await this.prisma.purchase_orders.count({ where: { status: 'PENDING' } });
    return { pending_purchase_orders };
  }

  // ─── Material Receipts (MRR — Local & Imported) ─────────────────────────

  async getMaterialReceipts(opts: {
    source?: 'LOCAL' | 'IMPORTED';
    status?: string;
    supplier_name?: string;
    limit?: number;
  } = {}): Promise<any[]> {
    const where: Record<string, any> = {};
    if (opts.source) where.source = opts.source;
    if (opts.status) where.status = { contains: opts.status };
    if (opts.supplier_name) where.suppliers = { name: { contains: opts.supplier_name } };

    const rows = await this.prisma.material_receipts.findMany({
      where,
      select: {
        id: true,
        custom_id: true,
        source: true,
        status: true,
        invoice_no: true,
        receipt_date: true,
        suppliers: { select: { name: true } },
        departments: { select: { name: true } },
      },
      take: opts.limit ?? 50,
      orderBy: { created_at: 'desc' },
    });
    return serializeBigInt(rows);
  }

  // ─── Item Returns ────────────────────────────────────────────────────────

  async getItemReturns(opts: { status?: string; is_received?: boolean; limit?: number } = {}): Promise<any[]> {
    const where: Record<string, any> = {};
    if (opts.status) where.status = { contains: opts.status };
    if (opts.is_received !== undefined) where.is_received = opts.is_received;

    const rows = await this.prisma.item_returns.findMany({
      where,
      select: {
        id: true,
        custom_id: true,
        status: true,
        is_received: true,
        reason: true,
        return_date: true,
        departments: { select: { name: true } },
        users: { select: { name: true } },
      },
      take: opts.limit ?? 50,
      orderBy: { created_at: 'desc' },
    });
    return serializeBigInt(rows);
  }

  // ─── Suppliers ───────────────────────────────────────────────────────────

  async getSuppliers(opts: { name?: string; limit?: number } = {}): Promise<any[]> {
    const where: Record<string, any> = {};
    if (opts.name) where.name = { contains: opts.name };

    const rows = await this.prisma.suppliers.findMany({
      where,
      select: {
        id: true,
        custom_id: true,
        name: true,
        first_contact_person_name: true,
        first_contact_person_phone: true,
        email: true,
        is_active: true,
      },
      take: opts.limit ?? 50,
      orderBy: { name: 'asc' },
    });
    return serializeBigInt(rows);
  }

  // ─── Tool manifest — name/description/schema/handler for LLM tool-calling ─

  get tools(): StoreTool[] {
    return [
      {
        name: 'get_products',
        description: 'Search/list inventory items (products), optionally filtered by name, item_code, category, or active status.',
        schema: z.object({
          name: z.string().optional().describe('Partial product name'),
          item_code: z.string().optional(),
          category: z.string().optional(),
          is_active: z.boolean().optional(),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getProducts(args),
      },
      {
        name: 'get_product_by_name',
        description: 'Look up a single item/product by name, item_code, or model number — includes current_stock, minimum_stock, unit_price, category, and UOM.',
        schema: z.object({ name: z.string() }),
        handler: (args) => this.getProductByName(args.name),
      },
      {
        name: 'get_low_stock_products',
        description: 'List items currently below their minimum stock level (current_stock >= 0 AND current_stock < minimum_stock — items with no minimum configured are excluded). Use for "low stock items"/"what needs reordering"/"items running low" questions.',
        schema: z.object({ limit: z.number().optional() }),
        handler: (args) => this.getLowStockProducts(args),
      },
      {
        name: 'get_low_stock_count',
        description: 'Get just the COUNT of items currently below their minimum stock level. Use for "how many items are low on stock" — not for the actual list (use get_low_stock_products for that).',
        schema: z.object({}),
        handler: () => this.getLowStockCount(),
      },
      {
        name: 'get_item_categories',
        description: 'List all active item/product categories.',
        schema: z.object({}),
        handler: () => this.getItemCategories(),
      },
      {
        name: 'get_idle_inventory',
        description: 'List idle inventory items (received stock sitting unused), optionally filtered by condition (e.g. "good", "damaged").',
        schema: z.object({
          condition: z.string().optional(),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getIdleInventory(args),
      },
      {
        name: 'get_purchase_requisitions',
        description: 'Get purchase requisitions — "Indent"/SPR (store → purchase department request) or SR (Store Requisition, issued from existing stock). Filter by type (SPR|SR), status (SUBMITTED|APPROVED|FINAL_APPROVAL|REJECTED — APPROVED is only GM/level-1 approval, FINAL_APPROVAL means fully approved and stock was decremented), urgency, department, or requester name.',
        schema: z.object({
          type: z.enum(['SPR', 'SR']).optional(),
          status: z.enum(['SUBMITTED', 'APPROVED', 'FINAL_APPROVAL', 'REJECTED']).optional(),
          urgency: z.string().optional(),
          department: z.string().optional(),
          requested_by_name: z.string().optional(),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getPurchaseRequisitions(args),
      },
      {
        name: 'get_purchase_requisition_status_breakdown',
        description: 'Get purchase requisition counts grouped by status, optionally filtered by type (SPR|SR). Use for "how many indents are pending/approved/rejected" questions.',
        schema: z.object({ type: z.enum(['SPR', 'SR']).optional() }),
        handler: (args) => this.getPurchaseRequisitionStatusBreakdown(args),
      },
      {
        name: 'get_purchase_orders',
        description: 'Get purchase orders, optionally filtered by status (PENDING|APPROVED|CANCELED|RECEIVED), supplier name, or is_imported (true = foreign/imported PO, false = local).',
        schema: z.object({
          status: z.enum(['PENDING', 'APPROVED', 'CANCELED', 'RECEIVED']).optional(),
          supplier_name: z.string().optional(),
          is_imported: z.boolean().optional(),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getPurchaseOrders(args),
      },
      {
        name: 'get_pending_purchase_orders_count',
        description: 'Get just the COUNT of purchase orders currently in PENDING status.',
        schema: z.object({}),
        handler: () => this.getPendingPurchaseOrdersCount(),
      },
      {
        name: 'get_material_receipts',
        description: 'Get Material Receipt Records (MRR), optionally filtered by source (LOCAL|IMPORTED), status, or supplier name.',
        schema: z.object({
          source: z.enum(['LOCAL', 'IMPORTED']).optional(),
          status: z.string().optional(),
          supplier_name: z.string().optional(),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getMaterialReceipts(args),
      },
      {
        name: 'get_item_returns',
        description: 'Get item return records, optionally filtered by status or whether the return has been received back into stock.',
        schema: z.object({
          status: z.string().optional(),
          is_received: z.boolean().optional(),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getItemReturns(args),
      },
      {
        name: 'get_suppliers',
        description: 'Search/list suppliers, optionally filtered by name.',
        schema: z.object({
          name: z.string().optional(),
          limit: z.number().optional(),
        }),
        handler: (args) => this.getSuppliers(args),
      },
    ];
  }

  findTool(name: string): StoreTool | undefined {
    return this.tools.find((t) => t.name === name);
  }
}
