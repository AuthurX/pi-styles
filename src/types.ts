export type Verbosity = "low" | "medium" | "high";

export interface TruncatePolicy {
  maxLines: number;
  keepHead: number;
  keepTail: number;
}

export interface StylePolicy {
  disabled_tools?: string[];
  active_tools?: string[];
  require_plan_confirm_before_write?: boolean;
  deny_write_globs?: string[];
  allow_write_globs?: string[];
  confirm_bash_patterns?: string[];
  deny_bash_patterns?: string[];
  confirm_overwrite_existing?: boolean;
  max_files_per_turn?: number;
  truncate_tool_output?: TruncatePolicy;
}

export interface StyleCost {
  verbosity?: Verbosity;
}

export type StyleSource = "project" | "claude-project" | "user" | "claude-user" | "builtin";

export interface Style {
  name: string;
  source: StyleSource;
  path: string;
  description: string;
  keepCodingInstructions: boolean;
  cost?: StyleCost;
  policy?: StylePolicy;
  body: string;
  parseWarnings: string[];
}

export interface StyleCostInfo {
  promptTokens: number;
  verbosity: Verbosity;
  policyBadge: string;
}

export interface EvidenceItem {
  timestamp: string;
  quote: string;
  kind: string;
}
