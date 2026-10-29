-- Billing (#131): row-level security for a workspace's subscriptions, and the SECURITY DEFINER
-- functions of the provider events log. Hand-written, like 0069.

ALTER TABLE billing_subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE billing_subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON billing_subscriptions
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- The events log is global (an event may name no workspace, or one of no tenant yet): the app
-- role can't read or write it, only claim and settle events through these functions.
REVOKE ALL ON billing_events FROM openrows_app;
--> statement-breakpoint

-- Records that the provider's event `p_event` arrived. True the first time; false when it was
-- received before (a replay or a retry of an applied event). Runs in the caller's transaction,
-- so a rolled-back delivery can be retried.
CREATE FUNCTION billing_event_claim(p_provider text, p_event text, p_type text)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF length(p_provider) NOT BETWEEN 1 AND 40 OR length(p_event) NOT BETWEEN 1 AND 200
     OR length(p_type) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid billing event';
  END IF;
  INSERT INTO billing_events (provider, event_id, type) VALUES (p_provider, p_event, p_type)
    ON CONFLICT DO NOTHING;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION billing_event_claim(text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing_event_claim(text, text, text) TO openrows_app;
--> statement-breakpoint

-- What a claimed event did, and the workspace it concerned.
CREATE FUNCTION billing_event_settle(p_provider text, p_event text, p_outcome text, p_workspace uuid)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  UPDATE billing_events SET outcome = left(p_outcome, 20), subject_workspace_id = p_workspace
   WHERE provider = p_provider AND event_id = p_event
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION billing_event_settle(text, text, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing_event_settle(text, text, text, uuid) TO openrows_app;
--> statement-breakpoint

-- The workspace a provider subscription belongs to, whichever tenant it is (null: none yet), so
-- an event can't move a subscription to another workspace. Ids only.
CREATE FUNCTION billing_subscription_workspace(p_provider text, p_subscription text)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT workspace_id FROM billing_subscriptions
   WHERE provider = p_provider AND subscription_id = p_subscription
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION billing_subscription_workspace(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing_subscription_workspace(text, text) TO openrows_app;
