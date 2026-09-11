import { queryVTiger } from './src/services/vtiger_api_service.js';
async function test() {
  const res = await queryVTiger("SELECT * FROM Contacts WHERE firstname = 'Carlos' AND lastname = 'Carvajal';");
  console.log(JSON.stringify(res, null, 2));
}
test();
