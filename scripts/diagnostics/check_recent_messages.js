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

  console.log('--- Checking Contact 5521983382935 ---');
  
  const { data: contacts } = await supabaseService
    .from('contacts')
    .select('*')
    .eq('phone', '+5521983382935');

  console.log('Contacts in DB:', JSON.stringify(contacts, null, 2));

  if (contacts && contacts.length > 0) {
    const contactId = contacts[0].id;
    const { data: convs } = await supabaseService
      .from('conversations')
      .select('id')
      .eq('contact_id', contactId);
    
    console.log('Conversations in DB:', JSON.stringify(convs, null, 2));

    if (convs && convs.length > 0) {
      const convId = convs[0].id;
      const { data: messages } = await supabaseService
        .from('messages')
        .select('*')
        .eq('conversation_id', convId)
        .order('created_at', { ascending: false });

      console.log('Messages in DB:', JSON.stringify(messages, null, 2));
    }
  }
}

check();
