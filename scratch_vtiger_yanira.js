import { findVTigerContact } from './src/services/vtiger_api_service.js';

async function test() {
  const contact = {
    id: "rPqLqAaZcEFhYatmNgdO",
    firstName: "Yanira",
    lastName: "Menendez",
    phone: "+12025708826", // let's guess her phone if we had it. I don't have it, wait.
    email: undefined
  };
  try {
    const vContact = await findVTigerContact(contact);
    console.log("vTiger Contact:", vContact);
  } catch (e) {
    console.log("Error:", e.message);
  }
}
test();
