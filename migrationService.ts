import { db } from './firebase';
import { collection, writeBatch, doc } from 'firebase/firestore';
import { apiCall } from './api';

const SHEET_COLLECTION_MAP: Record<string, string> = {
  'Bicicletas': 'bikes',
  'Acesso': 'users',
  'Solicitacao': 'requests',
  'Relatorio': 'reports',
  'Alertas': 'alerts',
  'Mecanica': 'pending_actions',
  'Estacao': 'stations',
  'Vandalizadas': 'vandalized',
  'Vandalismo': 'vandalism',
  'ResumoDiario': 'daily_summary',
  'Dados': 'driver_states',
  'Repor': 'replenishment',
  'FilaProcessamento': 'processing_queue',
  'CHASSI': 'chassis'
};

const FIELD_MAPS: Record<string, Record<string, string>> = {
  'Bicicletas': {
    'Patrimônio': 'patrimonio',
    'Status': 'status',
    'Localidade': 'localizacao',
    'Latitude': 'latitude',
    'Longitude': 'longitude',
    'Usuário': 'responsavel',
    'Bateria': 'bateria',
    'Trava': 'trava',
    'Carregamento': 'carregamento',
    'Última Info': 'ultimaAtualizacao'
  },
  'Acesso': {
    'Usuário': 'name',
    'Login': 'login',
    'Senha': 'password',
    'Categoria': 'category',
    'Placa': 'plate',
    'KM Final': 'lastKmFinal'
  },
  'Solicitacao': {
    'TIMESTAMP': 'timestamp',
    'Patrimônio': 'bikeNumber',
    'Ocorrência': 'reason',
    'Local': 'location',
    'Situação': 'status',
    'Destinatário': 'recipient',
    'Aceita por': 'driverName'
  },
  'Relatorio': {
    'TIMESTAMP': 'date',
    'Patrimônio': 'bikeNumber',
    'Status': 'type',
    'Observação': 'observation',
    'Motorista': 'driverName'
  },
  'Alertas': {
    'Patrimônio': 'bikeNumber',
    'Situação': 'status',
    'Encontrada por': 'driverName',
    'Data Encontrada': 'timestamp'
  },
  'Mecanica': {
    'Patrimônio': 'bikeNumber',
    'Status': 'status',
    'Data Entrada': 'timestamp',
    'Mecânico': 'mechanicName',
    'Tratativa': 'treatment',
    'Carretinha': 'trailerName'
  }
};

const normalizeId = (id: string) => {
  if (!id) return '';
  return id.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\//g, '_');
};

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

      // Mapear ou sanitizar nome da coleção
      const collectionName = SHEET_COLLECTION_MAP[sheetName] || sheetName.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const colRef = collection(db, collectionName);
      const fieldMap = FIELD_MAPS[sheetName] || {};
      
      let batch = writeBatch(db);
      let count = 0;

      console.log(`Migrando aba "${sheetName}" para a coleção "${collectionName}"...`);

      for (const row of rows) {
        if (!row) continue;

        // Transformar campos
        const transformedRow: any = {};
        Object.entries(row).forEach(([key, value]) => {
          const newKey = fieldMap[key] || key;
          transformedRow[newKey] = value;
        });

        // Tentar encontrar um ID adequado na linha
        let docId = null;
        const idKeys = ['patrimonio', 'login', 'id', 'ID', 'Email', 'email', 'Matrícula', 'matricula', 'Patrimônio', 'Usuário'];
        
        for (const key of idKeys) {
          if (transformedRow[key]) {
            docId = normalizeId(String(transformedRow[key]));
            break;
          }
        }

        const docRef = docId ? doc(colRef, docId) : doc(colRef);
        batch.set(docRef, {
          ...transformedRow,
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
