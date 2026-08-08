// ============================================================
// BATCHLY — verify-payment Edge Function
//
// Deploy the same way as initialize-payment: Edge Functions →
// Deploy a new function → Via Editor → name it exactly
// "verify-payment" → paste this in → Deploy.
// Uses the same PAYSTACK_SECRET_KEY secret — no extra setup needed
// if you already added it for initialize-payment.
//
// Why this exists as its own step: Paystack redirects the customer
// back to your site whether payment succeeded or not — the redirect
// itself proves nothing. This function asks Paystack directly,
// server-to-server, "did this reference actually succeed?" before
// Batchly ever upgrades anyone's plan.
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 });
    const { data: { user }, error: userError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (userError || !user) return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 });

    const { reference } = await req.json();
    if (!reference) return new Response(JSON.stringify({ error: 'Missing reference' }), { status: 400 });

    const { data: payment } = await supabase.from('payments').select('*').eq('reference', reference).maybeSingle();
    if (!payment) return new Response(JSON.stringify({ error: 'Unknown payment reference' }), { status: 404 });

    const verifyRes = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), {
      headers: { Authorization: 'Bearer ' + Deno.env.get('PAYSTACK_SECRET_KEY') },
    });
    const verifyData = await verifyRes.json();

    const success = verifyData.status && verifyData.data?.status === 'success';

    await supabase.from('payments').update({ status: success ? 'success' : 'failed' }).eq('reference', reference);

    if (success) {
      await supabase.from('pharmacies').update({ plan: payment.plan }).eq('id', payment.pharmacy_id);
    }

    return new Response(JSON.stringify({ success, plan: success ? payment.plan : null }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
