import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const BASE_UOM_VALUES = ['PIECE', 'PACK', 'CASE', 'PALLET', 'BOX'];
const STORAGE_CONDITION_VALUES = ['AMBIENT', 'CHILLED', 'FROZEN', 'NA'];
const WEIGHT_UOM_VALUES = ['KG', 'G', 'LB', 'TONNES'];
const ABC_VALUES = ['A', 'B', 'C'];
const STORAGE_UNIT_TYPES = ['EACH', 'INNER', 'CASE', 'PALLET'];
const BARCODE_TYPES = ['EACH', 'CASE', 'OTHER'];

@Injectable()
export class SkusService {
  constructor(private prisma: PrismaService) {}

  async create(data: any) {
    const errors: string[] = [];

    if (!data.code || !/^[A-Za-z0-9-]{1,30}$/.test(data.code)) {
      errors.push('SKU Code is required: alphanumeric/hyphens only, max 30 characters.');
    }
    if (!data.description || data.description.length < 3 || data.description.length > 200) {
      errors.push('Description is required: 3-200 characters.');
    }
    if (!data.baseUom) {
      errors.push('Base UOM is required.');
    } else if (!BASE_UOM_VALUES.includes(data.baseUom)) {
      errors.push(`Base UOM must be one of: ${BASE_UOM_VALUES.join(', ')}`);
    }
    if (!data.hsnCode || !/^\d{4}(\d{2})?(\d{2})?$/.test(data.hsnCode)) {
      errors.push('HSN Code is required: numeric only, 4, 6, or 8 digits.');
    }
    const storageCondition = data.storageCondition || 'AMBIENT';
    if (!STORAGE_CONDITION_VALUES.includes(storageCondition)) {
      errors.push(`Storage Condition must be one of: ${STORAGE_CONDITION_VALUES.join(', ')}`);
    }
    if (data.shelfLifeTracked && (!data.shelfLifeDays || data.shelfLifeDays <= 0)) {
      errors.push('Shelf Life Days is required (positive number) when Shelf-Life Tracked is true.');
    }
    if (data.grossWeight && !data.weightUom) {
      errors.push('Weight UOM is required when Gross Weight is provided.');
    }
    if (data.weightUom && !WEIGHT_UOM_VALUES.includes(data.weightUom)) {
      errors.push(`Weight UOM must be one of: ${WEIGHT_UOM_VALUES.join(', ')}`);
    }
    if (data.grossWeight !== undefined && data.grossWeight !== null && data.grossWeight <= 0) {
      errors.push('Gross Weight must be a positive number.');
    }
    if (data.isHazmat && !data.hazmatClass) {
      errors.push('Hazmat Class is required when Hazmat is true.');
    }
    if (data.abcClass && !ABC_VALUES.includes(data.abcClass)) {
      errors.push(`ABC Classification must be one of: ${ABC_VALUES.join(', ')}`);
    }
    if (data.standardCost !== undefined && data.standardCost !== null && data.standardCost < 0) {
      errors.push('Standard Cost cannot be negative.');
    }
    if (data.moq !== undefined && data.moq !== null && data.moq <= 0) {
      errors.push('MOQ must be a positive number.');
    }

    if (!data.storageUnits || data.storageUnits.length === 0) {
      errors.push('At least one storage unit is required (e.g. Piece = 1).');
    } else {
      let preferredCount = 0;
      for (const unit of data.storageUnits) {
        if (!STORAGE_UNIT_TYPES.includes(unit.unitType)) {
          errors.push(`Storage Unit type must be one of: ${STORAGE_UNIT_TYPES.join(', ')}`);
        }
        if (!unit.qtyInBaseUom || unit.qtyInBaseUom <= 0) {
          errors.push('Storage Unit quantity must be a positive number.');
        }
        if (unit.isPreferred) preferredCount++;
      }
      if (preferredCount > 1) {
        errors.push('Only one storage unit can be marked as Preferred.');
      }
    }

    if (data.barcodes && data.barcodes.length > 0) {
      for (const bc of data.barcodes) {
        if (!bc.barcode) {
          errors.push('Barcode value cannot be empty.');
        }
        if (!BARCODE_TYPES.includes(bc.type)) {
          errors.push(`Barcode type must be one of: ${BARCODE_TYPES.join(', ')}`);
        }
      }
      const barcodeValues = data.barcodes.map((b: any) => b.barcode);
      const existing = await this.prisma.skuBarcode.findMany({
        where: { barcode: { in: barcodeValues } },
      });
      if (existing.length > 0) {
        errors.push(`Barcode(s) already in use: ${existing.map((e) => e.barcode).join(', ')}`);
      }
    }

    if (errors.length > 0) {
      throw new BadRequestException(errors);
    }

    return this.prisma.sku.create({
      data: {
        code: data.code.toUpperCase(),
        description: data.description,
        category: data.category || 'Uncategorized',
        subCategory: data.subCategory,
        baseUom: data.baseUom,
        hsnCode: data.hsnCode,
        storageCondition: storageCondition,
        batchTracked: !!data.batchTracked,
        shelfLifeTracked: !!data.shelfLifeTracked,
        shelfLifeDays: data.shelfLifeDays,
        isActive: data.isActive !== undefined ? data.isActive : true,
        weightUom: data.weightUom,
        grossWeight: data.grossWeight,
        isHazmat: !!data.isHazmat,
        hazmatClass: data.hazmatClass,
        hasUniqueBarcode: !!data.hasUniqueBarcode,
        abcClass: data.abcClass,
        currency: data.currency,
        standardCost: data.standardCost,
        moq: data.moq,
        storageUnits: { create: data.storageUnits },
        barcodes: data.barcodes ? { create: data.barcodes } : undefined,
      },
      include: { storageUnits: true, barcodes: true },
    });
  }

  findAll() {
    return this.prisma.sku.findMany({
      include: { storageUnits: true, barcodes: true },
    });
  }
}