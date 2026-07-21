// Hand-written to match supabase/migrations/0001_init.sql.
// Regenerate with the Supabase CLI once linked:
//   supabase gen types typescript --linked > types/database.ts

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
    };
    Views: Record<string, never>;
    Functions: {
      current_group_id: { Args: Record<string, never>; Returns: string };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];

export type Group = Tables<'groups'>;
export type Profile = Tables<'profiles'>;
export type Spending = Tables<'spendings'>;
export type Income = Tables<'income'>;
