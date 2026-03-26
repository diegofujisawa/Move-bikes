import { db } from './firebase';
import { collection, writeBatch, doc } from 'firebase/firestore';
import { apiCall } from './api';

export const migrateDataToFirebase = async (category: string) => {
  try {
    console.log('Iniciando exportação de dados do Google Sheets...');
    const result = await apiCall({ action: 'exportAllData', category });
    
    if (!result.success || !result.data) {
      throw new Error(result.error || 'Falha ao exportar dados.');
    }

    const data = result.data;
    const sheets = Object.keys(data);
    let totalMigrated = 0;

    for (const sheetName of sheets) {
      const rows = data[sheetName];
      if (!Array.isArray(rows) || rows.length === 0) continue;

      // Sanitizar nome da coleção para o Firestore
      const collectionName = sheetName.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const colRef = collection(db, collectionName);
      let batch = writeBatch(db);
      let count = 0;

      console.log(`Migrando aba "${sheetName}" para a coleção "${collectionName}"...`);

      for (const row of rows) {
        if (!row) continue;

        // Tentar encontrar um ID adequado na linha
        let docId = null;
        const idKeys = ['Patrimônio', 'Usuário', 'ID', 'id', 'Email', 'email', 'Matrícula', 'matricula'];
        
        for (const key of idKeys) {
          if (row[key]) {
            docId = String(row[key]).trim();
            break;
          }
        }

        const docRef = docId ? doc(colRef, docId.replace(/\//g, '_')) : doc(colRef);
        batch.set(docRef, {
          ...row,
          _migratedAt: new Date().toISOString(),
          _originalSheet: sheetName
        });

        count++;
        totalMigrated++;

        // Firestore batch limit is 500
        if (count === 450) {
          await batch.commit();
          batch = writeBatch(db);
          count = 0;
        }
      }

      if (count > 0) {
        await batch.commit();
      }
      console.log(`Migrados ${rows.length} registros da aba "${sheetName}"`);
    }

    console.log('Migração concluída com sucesso!');
    return { success: true, total: totalMigrated };
  } catch (error: any) {
    console.error('Erro na migração:', error);
    return { success: false, error: error.message };
  }
};
