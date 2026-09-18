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

  console.log('--- Checking All Messages for Audio / Media file indicators ---');
  const { data: messages, error } = await supabaseService
    .from('messages')
    .select('id, content_type, content_text, media_url, sender_type, message_id, created_at')
    .or('content_type.eq.audio,media_url.like.%.ogg,media_url.like.%.mp3,media_url.like.%.m4a,media_url.like.%.opus')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching messages:', error);
  } else {
    console.log(`Found ${messages?.length || 0} potential audio messages.`);
    console.log(JSON.stringify(messages, null, 2));
  }
}

check();
