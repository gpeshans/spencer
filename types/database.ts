// Hand-written to match supabase/migrations/0001_init.sql.
// Regenerate with the Supabase CLI once linked:
//   supabase gen types typescript --linked > types/database.ts

/** Must match the check constraint on report_runs.status (and the engine's RUN_STATUSES). */
export type ReportRunStatus =
  | 'received'
  | 'planning'
  | 'needs_clarification'
  | 'awaiting_approval'
  | 'executing'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'rejected'
  | 'expired';

/** Must match the check constraint on report_events.action. */
export type ReportEventAction =
  | 'create'
  | 'clarify'
  | 'approve'
  | 'reject'
  | 'save'
  | 'share'
  | 'unshare'
  | 'schedule'
  | 'unschedule'
  | 'delete'
  | 'download'
  | 'expire'
  | 'disable';

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      groups: {
        Row: { id: string; name: string; currency: string; created_at: string };
        Insert: { id?: string; name: string; currency?: string; created_at?: string };
        Update: { id?: string; name?: string; currency?: string; created_at?: string };
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          group_id: string;
          email: string | null;
          display_name: string | null;
          avatar_url: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          group_id: string;
          email?: string | null;
          display_name?: string | null;
          avatar_url?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          group_id?: string;
          email?: string | null;
          display_name?: string | null;
          avatar_url?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      spendings: {
        Row: {
          id: string;
          group_id: string;
          user_id: string;
          description: string;
          amount: number;
          category: string;
          bucket: Database['public']['Enums']['bucket'];
          spent_on: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          group_id?: string; // defaulted to current_group_id()
          user_id?: string; // defaulted to auth.uid()
          description?: string;
          amount: number;
          category: string;
          bucket?: Database['public']['Enums']['bucket']; // set by trigger from category
          spent_on?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          group_id?: string;
          user_id?: string;
          description?: string;
          amount?: number;
          category?: string;
          bucket?: Database['public']['Enums']['bucket']; // re-derived by trigger
          spent_on?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      income: {
        Row: {
          id: string;
          group_id: string;
          category: string;
          amount: number;
          effective_from: string;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          group_id?: string; // defaulted to current_group_id()
          category: string;
          amount: number;
          effective_from?: string;
          created_by?: string | null; // defaulted to auth.uid()
          created_at?: string;
        };
        Update: {
          id?: string;
          group_id?: string;
          category?: string;
          amount?: number;
          effective_from?: string;
          created_by?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      categories: {
        // Per-group, editable expense/income categories (source of truth for the
        // category lists; historical spendings/income rows reference `key`).
        Row: {
          id: string;
          group_id: string;
          kind: 'expense' | 'income';
          key: string;
          label: string;
          icon_name: string;
          color: string;
          bucket: Database['public']['Enums']['bucket'] | null; // expense only
          sort: number;
          active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          group_id?: string; // defaulted to current_group_id()
          kind: 'expense' | 'income';
          key: string;
          label: string;
          icon_name?: string;
          color?: string;
          bucket?: Database['public']['Enums']['bucket'] | null;
          sort?: number;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          group_id?: string;
          kind?: 'expense' | 'income';
          key?: string;
          label?: string;
          icon_name?: string;
          color?: string;
          bucket?: Database['public']['Enums']['bucket'] | null;
          sort?: number;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      bucket_targets: {
        // Per-group target share of income per bucket (percent).
        Row: {
          group_id: string;
          bucket: Database['public']['Enums']['bucket'];
          target_pct: number;
          updated_at: string;
        };
        Insert: {
          group_id?: string; // defaulted to current_group_id()
          bucket: Database['public']['Enums']['bucket'];
          target_pct: number;
          updated_at?: string;
        };
        Update: {
          group_id?: string;
          bucket?: Database['public']['Enums']['bucket'];
          target_pct?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      // Report engine (migration 0008). Users read their own rows under RLS;
      // only the server writes, with the secret key.
      report_runs: {
        Row: {
          id: string;
          owner_id: string;
          group_id: string;
          template_id: string | null;
          triggered_by: 'interactive' | 'scheduled';
          request: string;
          output_type: 'ui' | 'pdf';
          status: ReportRunStatus;
          stage: string | null;
          intent: Json | null;
          feasibility: Json | null;
          plan: Json | null;
          plan_hash: string | null;
          clarification: Json | null;
          result: Json | null;
          error: Json | null;
          input_tokens: number;
          output_tokens: number;
          cache_read_tokens: number;
          cache_write_tokens: number;
          cost_usd: number;
          stage_timings: Json;
          approval_expires_at: string | null;
          scheduled_for: string | null;
          started_at: string | null;
          finished_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          owner_id: string;
          group_id: string;
          template_id?: string | null;
          triggered_by?: 'interactive' | 'scheduled';
          request: string;
          output_type?: 'ui' | 'pdf';
          status?: ReportRunStatus;
          stage?: string | null;
          intent?: Json | null;
          feasibility?: Json | null;
          plan?: Json | null;
          plan_hash?: string | null;
          clarification?: Json | null;
          result?: Json | null;
          error?: Json | null;
          input_tokens?: number;
          output_tokens?: number;
          cache_read_tokens?: number;
          cache_write_tokens?: number;
          cost_usd?: number;
          stage_timings?: Json;
          approval_expires_at?: string | null;
          scheduled_for?: string | null;
          started_at?: string | null;
          finished_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['report_runs']['Insert']>;
        Relationships: [];
      };
      report_queries: {
        Row: {
          id: string;
          run_id: string;
          section_id: string;
          attempt: number;
          source: 'llm' | 'compiled' | 'probe';
          sql: string;
          fingerprint: string | null;
          summary: string | null;
          validation: Json | null;
          explain_cost: number | null;
          row_count: number | null;
          truncated: boolean;
          duration_ms: number | null;
          error: Json | null;
          cross_check: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          run_id: string;
          section_id: string;
          attempt?: number;
          source: 'llm' | 'compiled' | 'probe';
          sql: string;
          fingerprint?: string | null;
          summary?: string | null;
          validation?: Json | null;
          explain_cost?: number | null;
          row_count?: number | null;
          truncated?: boolean;
          duration_ms?: number | null;
          error?: Json | null;
          cross_check?: Json | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['report_queries']['Insert']>;
        Relationships: [];
      };
      report_llm_calls: {
        Row: {
          id: string;
          run_id: string | null;
          owner_id: string | null;
          stage: string;
          attempt: number;
          provider: string;
          model_requested: string;
          model_served: string | null;
          fallback_reason: string | null;
          effort: string | null;
          input_tokens: number;
          output_tokens: number;
          cache_read_tokens: number;
          cache_write_tokens: number;
          cost_usd: number;
          latency_ms: number | null;
          ttft_ms: number | null;
          stop_reason: string | null;
          request_id: string | null;
          error_class: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          run_id?: string | null;
          owner_id?: string | null;
          stage: string;
          attempt?: number;
          provider?: string;
          model_requested: string;
          model_served?: string | null;
          fallback_reason?: string | null;
          effort?: string | null;
          input_tokens?: number;
          output_tokens?: number;
          cache_read_tokens?: number;
          cache_write_tokens?: number;
          cost_usd?: number;
          latency_ms?: number | null;
          ttft_ms?: number | null;
          stop_reason?: string | null;
          request_id?: string | null;
          error_class?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['report_llm_calls']['Insert']>;
        Relationships: [];
      };
      report_events: {
        Row: {
          id: string;
          actor_id: string | null;
          group_id: string | null;
          run_id: string | null;
          template_id: string | null;
          action: ReportEventAction;
          details: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          actor_id?: string | null;
          group_id?: string | null;
          run_id?: string | null;
          template_id?: string | null;
          action: ReportEventAction;
          details?: Json;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['report_events']['Insert']>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      bucket: 'needs' | 'wants' | 'savings' | 'emergency';
    };
    CompositeTypes: Record<string, never>;
  };
}

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];

export type Group = Tables<'groups'>;
export type Profile = Tables<'profiles'>;
export type Spending = Tables<'spendings'>;
export type Income = Tables<'income'>;
export type CategoryRow = Tables<'categories'>;
export type BucketTarget = Tables<'bucket_targets'>;
export type ReportRunRow = Tables<'report_runs'>;
