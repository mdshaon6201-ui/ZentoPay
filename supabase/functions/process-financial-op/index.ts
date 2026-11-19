// Supabase Edge Function: process-financial-op
// Executes privileged, server-side atomic financial mutations using SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: authData, error: authErr } = await userClient.auth.getUser();
    if (authErr || !authData.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized user session' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const body = await req.json();
    const { operation } = body;

    if (operation === 'wallet_transfer') {
      const { senderWalletId, recipientEmail, amount, description, currency } = body;
      if (currency !== undefined && String(currency).trim().toUpperCase() !== 'BDT') {
        return new Response(JSON.stringify({ error: 'Only BDT currency transfers are supported' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const numericAmount = Number(amount);
      if (!senderWalletId || !recipientEmail || !Number.isFinite(numericAmount) || numericAmount <= 0) {
        return new Response(JSON.stringify({ error: 'Valid senderWalletId, recipientEmail, and positive BDT amount required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { data: callerProfile } = await adminClient
        .from('profiles')
        .select('id, role, is_frozen')
        .eq('id', authData.user.id)
        .single();

      if (!callerProfile || callerProfile.is_frozen) {
        return new Response(JSON.stringify({ error: 'Caller account is unavailable or frozen' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { data: senderWallet } = await adminClient
        .from('wallets')
        .select('id, user_id, currency, status')
        .eq('id', senderWalletId)
        .eq('user_id', authData.user.id)
        .eq('currency', 'BDT')
        .eq('status', 'active')
        .single();

      if (!senderWallet) {
        return new Response(JSON.stringify({ error: 'Active BDT sender wallet not owned by caller' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const cleanRecipientEmail = String(recipientEmail).trim().toLowerCase();
      const { data: recipientProfile } = await adminClient
        .from('profiles')
        .select('id, is_frozen')
        .eq('email', cleanRecipientEmail)
        .single();

      if (!recipientProfile || recipientProfile.is_frozen) {
        return new Response(JSON.stringify({ error: 'Recipient account not found or frozen' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { data: receiverWallet } = await adminClient
        .from('wallets')
        .select('id, currency, status')
        .eq('user_id', recipientProfile.id)
        .eq('wallet_type', 'main')
        .eq('currency', 'BDT')
        .eq('status', 'active')
        .single();

      if (!receiverWallet) {
        return new Response(JSON.stringify({ error: 'Recipient active BDT main wallet unavailable' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (senderWallet.id === receiverWallet.id) {
        return new Response(JSON.stringify({ error: 'Cannot transfer to the same wallet' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const feeAmount = Number((numericAmount * 0.005).toFixed(2));
      const { data: txId, error: rpcError } = await adminClient.rpc('execute_wallet_transfer', {
        p_sender_wallet_id: senderWallet.id,
        p_receiver_wallet_id: receiverWallet.id,
        p_initiator_user_id: authData.user.id,
        p_amount: numericAmount,
        p_fee_amount: feeAmount,
        p_description: description || `Transfer to ${cleanRecipientEmail}`,
      });

      if (rpcError) {
        return new Response(JSON.stringify({ error: rpcError.message }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ transactionId: txId, feeAmount, currency: 'BDT', status: 'completed' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Unsupported financial operation' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
