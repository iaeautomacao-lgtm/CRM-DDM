const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Configure NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente.');
}

async function check() {
  const options = {
    db: {
      schema: 'wacrm'
    }
  };
  const supabaseService = createClient(supabaseUrl, serviceRoleKey, options);

  console.log('--- Checking Last 20 Messages in DB ---');
  const { data: messages, error } = await supabaseService
    .from('messages')
    .select('id, content_type, content_text, media_url, sender_type, message_id, created_at')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('Error fetching messages:', error);
  } else {
    console.log(JSON.stringify(messages, null, 2));
  }
}

check();
