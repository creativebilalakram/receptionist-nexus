export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      appointments: {
        Row: {
          booked_via: string
          cancellation_reason: string | null
          client_id: string
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          conversation_id: string | null
          created_at: string
          duration_minutes: number | null
          effective_end_at: string | null
          id: string
          meeting_type_id: string | null
          notes: string | null
          parent_appointment_id: string | null
          reminder_sent_at: string | null
          reschedule_count: number
          scheduled_at: string
          second_reminder_sent_at: string | null
          status: string
        }
        Insert: {
          booked_via?: string
          cancellation_reason?: string | null
          client_id: string
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          conversation_id?: string | null
          created_at?: string
          duration_minutes?: number | null
          effective_end_at?: string | null
          id?: string
          meeting_type_id?: string | null
          notes?: string | null
          parent_appointment_id?: string | null
          reminder_sent_at?: string | null
          reschedule_count?: number
          scheduled_at: string
          second_reminder_sent_at?: string | null
          status?: string
        }
        Update: {
          booked_via?: string
          cancellation_reason?: string | null
          client_id?: string
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          conversation_id?: string | null
          created_at?: string
          duration_minutes?: number | null
          effective_end_at?: string | null
          id?: string
          meeting_type_id?: string | null
          notes?: string | null
          parent_appointment_id?: string | null
          reminder_sent_at?: string | null
          reschedule_count?: number
          scheduled_at?: string
          second_reminder_sent_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_meeting_type_id_fkey"
            columns: ["meeting_type_id"]
            isOneToOne: false
            referencedRelation: "meeting_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_parent_appointment_id_fkey"
            columns: ["parent_appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
        ]
      }
      availability_rules: {
        Row: {
          client_id: string
          created_at: string
          day_of_week: number
          end_time: string
          id: string
          is_enabled: boolean
          start_time: string
        }
        Insert: {
          client_id: string
          created_at?: string
          day_of_week: number
          end_time?: string
          id?: string
          is_enabled?: boolean
          start_time?: string
        }
        Update: {
          client_id?: string
          created_at?: string
          day_of_week?: number
          end_time?: string
          id?: string
          is_enabled?: boolean
          start_time?: string
        }
        Relationships: [
          {
            foreignKeyName: "availability_rules_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      blocked_dates: {
        Row: {
          client_id: string
          created_at: string
          end_at: string
          id: string
          reason: string | null
          start_at: string
        }
        Insert: {
          client_id: string
          created_at?: string
          end_at: string
          id?: string
          reason?: string | null
          start_at: string
        }
        Update: {
          client_id?: string
          created_at?: string
          end_at?: string
          id?: string
          reason?: string | null
          start_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "blocked_dates_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_settings: {
        Row: {
          auto_buffer_after_minutes: number
          cancellation_window_hours: number
          client_id: string
          confirmation_template: string
          created_at: string
          id: string
          manychat_api_key: string | null
          max_advance_days: number
          min_notice_minutes: number
          reminder_hours_before: number
          reminder_template: string
          second_reminder_hours_before: number
        }
        Insert: {
          auto_buffer_after_minutes?: number
          cancellation_window_hours?: number
          client_id: string
          confirmation_template?: string
          created_at?: string
          id?: string
          manychat_api_key?: string | null
          max_advance_days?: number
          min_notice_minutes?: number
          reminder_hours_before?: number
          reminder_template?: string
          second_reminder_hours_before?: number
        }
        Update: {
          auto_buffer_after_minutes?: number
          cancellation_window_hours?: number
          client_id?: string
          confirmation_template?: string
          created_at?: string
          id?: string
          manychat_api_key?: string | null
          max_advance_days?: number
          min_notice_minutes?: number
          reminder_hours_before?: number
          reminder_template?: string
          second_reminder_hours_before?: number
        }
        Relationships: [
          {
            foreignKeyName: "booking_settings_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          ai_model: string
          booking_link: string | null
          business_hours: string | null
          business_name: string
          created_at: string
          faq: string | null
          icp: string | null
          id: string
          is_active: boolean
          niche: string | null
          objection_notes: string | null
          owner_id: string
          services: string | null
          slug: string
          system_prompt_override: string | null
          timezone: string
          tone_notes: string | null
          use_job_queue: boolean
          webhook_secret: string
        }
        Insert: {
          ai_model?: string
          booking_link?: string | null
          business_hours?: string | null
          business_name: string
          created_at?: string
          faq?: string | null
          icp?: string | null
          id?: string
          is_active?: boolean
          niche?: string | null
          objection_notes?: string | null
          owner_id: string
          services?: string | null
          slug: string
          system_prompt_override?: string | null
          timezone?: string
          tone_notes?: string | null
          use_job_queue?: boolean
          webhook_secret?: string
        }
        Update: {
          ai_model?: string
          booking_link?: string | null
          business_hours?: string | null
          business_name?: string
          created_at?: string
          faq?: string | null
          icp?: string | null
          id?: string
          is_active?: boolean
          niche?: string | null
          objection_notes?: string | null
          owner_id?: string
          services?: string | null
          slug?: string
          system_prompt_override?: string | null
          timezone?: string
          tone_notes?: string | null
          use_job_queue?: boolean
          webhook_secret?: string
        }
        Relationships: [
          {
            foreignKeyName: "clients_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          client_id: string
          created_at: string
          current_stage: string
          escalated: boolean
          escalated_at: string | null
          escalation_reason: string | null
          first_name: string | null
          followup_count: number
          followup_sent_at: string | null
          id: string
          language: string | null
          last_message_at: string | null
          last_offered_slot_iso: string | null
          last_reasoning: string | null
          lead_score: number
          manual_takeover: boolean
          messages: Json
          phone: string | null
          qualification: Json
          status: string
          subscriber_id: string
        }
        Insert: {
          client_id: string
          created_at?: string
          current_stage?: string
          escalated?: boolean
          escalated_at?: string | null
          escalation_reason?: string | null
          first_name?: string | null
          followup_count?: number
          followup_sent_at?: string | null
          id?: string
          language?: string | null
          last_message_at?: string | null
          last_offered_slot_iso?: string | null
          last_reasoning?: string | null
          lead_score?: number
          manual_takeover?: boolean
          messages?: Json
          phone?: string | null
          qualification?: Json
          status?: string
          subscriber_id: string
        }
        Update: {
          client_id?: string
          created_at?: string
          current_stage?: string
          escalated?: boolean
          escalated_at?: string | null
          escalation_reason?: string | null
          first_name?: string | null
          followup_count?: number
          followup_sent_at?: string | null
          id?: string
          language?: string | null
          last_message_at?: string | null
          last_offered_slot_iso?: string | null
          last_reasoning?: string | null
          lead_score?: number
          manual_takeover?: boolean
          messages?: Json
          phone?: string | null
          qualification?: Json
          status?: string
          subscriber_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_types: {
        Row: {
          buffer_after_minutes: number
          buffer_before_minutes: number
          client_id: string
          created_at: string
          description: string | null
          duration_minutes: number
          id: string
          is_active: boolean
          is_default: boolean
          name: string
        }
        Insert: {
          buffer_after_minutes?: number
          buffer_before_minutes?: number
          client_id: string
          created_at?: string
          description?: string | null
          duration_minutes: number
          id?: string
          is_active?: boolean
          is_default?: boolean
          name: string
        }
        Update: {
          buffer_after_minutes?: number
          buffer_before_minutes?: number
          client_id?: string
          created_at?: string
          description?: string | null
          duration_minutes?: number
          id?: string
          is_active?: boolean
          is_default?: boolean
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "meeting_types_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      outbound_jobs: {
        Row: {
          attempts: number
          client_id: string
          conversation_id: string | null
          created_at: string
          id: string
          job_type: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          next_run_at: string
          payload: Json
          status: string
          succeeded_at: string | null
          updated_at: string
        }
        Insert: {
          attempts?: number
          client_id: string
          conversation_id?: string | null
          created_at?: string
          id?: string
          job_type: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          next_run_at?: string
          payload?: Json
          status?: string
          succeeded_at?: string | null
          updated_at?: string
        }
        Update: {
          attempts?: number
          client_id?: string
          conversation_id?: string | null
          created_at?: string
          id?: string
          job_type?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          next_run_at?: string
          payload?: Json
          status?: string
          succeeded_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "outbound_jobs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outbound_jobs_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          agency_name: string | null
          created_at: string
          full_name: string | null
          id: string
        }
        Insert: {
          agency_name?: string | null
          created_at?: string
          full_name?: string | null
          id: string
        }
        Update: {
          agency_name?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
        }
        Relationships: []
      }
      webhook_logs: {
        Row: {
          client_id: string | null
          created_at: string
          direction: string
          error: string | null
          id: string
          payload: Json | null
          response: Json | null
          status_code: number | null
        }
        Insert: {
          client_id?: string | null
          created_at?: string
          direction: string
          error?: string | null
          id?: string
          payload?: Json | null
          response?: Json | null
          status_code?: number | null
        }
        Update: {
          client_id?: string | null
          created_at?: string
          direction?: string
          error?: string | null
          id?: string
          payload?: Json | null
          response?: Json | null
          status_code?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "webhook_logs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_outbound_job: {
        Args: { _worker_id: string }
        Returns: {
          attempts: number
          client_id: string
          conversation_id: string | null
          created_at: string
          id: string
          job_type: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          next_run_at: string
          payload: Json
          status: string
          succeeded_at: string | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "outbound_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      reset_stale_outbound_jobs: { Args: never; Returns: number }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
