import type { ColumnType, Generated } from 'kysely';

/** DATETIME(3), always stored and read as UTC. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

/**
 * DATE columns. The pool is configured with `dateStrings: ['DATE']` so these come
 * back as 'YYYY-MM-DD', matching what the frontend already receives. Letting them
 * become Date objects would serialise as full ISO datetimes and silently change
 * the public API shape of `dob` and `event_date`.
 */
type DateOnly = string;

export interface VisitorsTable {
  id: string;
  qr_code_id: string;
  name: string;
  email: string;
  mobile: string;
  dob: DateOnly;
  profession: string;
  payment_status: string;
  entry_status: boolean;
  payment_method: string | null;
  checked_in_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  ticket_tier_id: string | null;
  ticket_price: number | null;
  includes_concert: boolean;
  exited_status: boolean;
  exited_at: Timestamp | null;
}

export interface EventSettingsTable {
  id: number;
  event_date: DateOnly;
  event_end_date: DateOnly | null;
  ground_capacity: number;
  updated_at: Generated<Timestamp>;
}

export interface TicketTiersTable {
  id: string;
  day: string;
  start_time: string;
  end_time: string;
  price: number;
  includes_concert: boolean;
  label_en: string | null;
  label_bn: string | null;
  is_active: boolean;
  display_order: number;
  created_at: Generated<Timestamp>;
}

export interface GuestsTable {
  id: string;
  type: string;
  name: string;
  designation: string;
  image_url: string | null;
  bio: string | null;
  name_bn: string | null;
  name_en: string | null;
  designation_bn: string | null;
  designation_en: string | null;
  bio_bn: string | null;
  bio_en: string | null;
  display_order: number;
  created_at: Generated<Timestamp>;
}

export interface AdvisorsTable {
  id: string;
  name: string;
  title: string;
  organization: string | null;
  image_url: string | null;
  name_bn: string | null;
  name_en: string | null;
  title_bn: string | null;
  title_en: string | null;
  organization_bn: string | null;
  organization_en: string | null;
  display_order: number;
  created_at: Generated<Timestamp>;
}

export interface ManagementMembersTable {
  id: string;
  name: string;
  role: string;
  contact: string | null;
  image_url: string | null;
  name_bn: string | null;
  name_en: string | null;
  role_bn: string | null;
  role_en: string | null;
  display_order: number;
  created_at: Generated<Timestamp>;
}

export interface SponsorsTable {
  id: string;
  name: string;
  category: string;
  logo_url: string | null;
  website: string | null;
  name_bn: string | null;
  name_en: string | null;
  category_bn: string | null;
  category_en: string | null;
  display_order: number;
  created_at: Generated<Timestamp>;
}

export interface BrandStallsTable {
  id: string;
  name: string;
  category: string;
  logo_url: string | null;
  name_bn: string | null;
  name_en: string | null;
  category_bn: string | null;
  category_en: string | null;
  display_order: number;
  created_at: Generated<Timestamp>;
}

export interface Database {
  visitors: VisitorsTable;
  event_settings: EventSettingsTable;
  ticket_tiers: TicketTiersTable;
  guests: GuestsTable;
  advisors: AdvisorsTable;
  management_members: ManagementMembersTable;
  sponsors: SponsorsTable;
  brand_stalls: BrandStallsTable;
}

/** The content collections the admin CRUD endpoints may address. */
export type ContentTableName =
  | 'guests'
  | 'advisors'
  | 'management_members'
  | 'sponsors'
  | 'brand_stalls';
