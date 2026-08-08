// ============================================================
// BATCHLY — initialize-payment Edge Function
//
// HOW TO DEPLOY (from your phone, no computer needed):
// 1. Supabase Dashboard → Edge Functions → "Deploy a new function" → "Via Editor"
// 2. Name it exactly: initialize-payment
// 3. Delete the template code, paste this whole file in
// 4. Before deploying: Project Settings → Edge Functions → Secrets
//    → add a secret named PAYSTACK_SECRET_KEY with your Paystack
//    secret key as the value (starts with sk_test_ while testing,
//    sk_live_ once you're really taking payments)
// 5. Click Deploy
//
// This function decides the price itself — it never trusts a price
// sent from the browser, since a person could otherwise edit that
// request and pay ₦1 for a ₦4,500 plan.
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const PLAN_PRICES_KOBO: Record<string, number> = {
  growth: 450000, // ₦4,500 in kobo — Paystack always takes amounts in kobo, not naira
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Identify the caller from their own auth token — never trust a
    // pharmacy_id sent in the request body, only what their session
    // actually proves they belong to.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 });

    const { data: { user }, error: userError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (userError || !user) return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 });

    const { plan } = await req.json();
    const amount = PLAN_PRICES_KOBO[plan];
    if (!amount) return new Response(JSON.stringify({ error: 'Unknown plan' }), { status: 400 });

    const { data: membership } = await supabase
      .from('pharmacy_staff').select('pharmacy_id, role').eq('user_id', user.id).maybeSingle();
    if (!membership) return new Response(JSON.stringify({ error: 'No pharmacy found for this account' }), { status: 404 });
    if (membership.role !== 'owner') {
      return new Response(JSON.stringify({ error: 'Only the pharmacy owner can change the plan' }), { status: 403 });
    }

    const reference = 'batchly_' + crypto.randomUUID();

    const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + Deno.env.get('PAYSTACK_SECRET_KEY'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: user.email,
        amount,
        reference,
        callback_url: req.headers.get('origin') + '/dashboard.html',
      }),
    });

    const paystackData = await paystackRes.json();
    if (!paystackData.status) {
      return new Response(JSON.stringify({ error: paystackData.message || 'Paystack initialization failed' }), { status: 502 });
    }

    await supabase.from('payments').insert({
      pharmacy_id: membership.pharmacy_id, reference, amount_kobo: amount, plan, status: 'pending',
    });

    return new Response(JSON.stringify({ authorization_url: paystackData.data.authorization_url, reference }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
