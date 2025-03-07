import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

function App() {
  const [prices, setPrices] = useState(() => {
    const savedPrices = localStorage.getItem('prices');
    return savedPrices ? JSON.parse(savedPrices) : [];
  });
  const [productLinks, setProductLinks] = useState(() => {
    const savedLinks = localStorage.getItem('productLinks');
    let initialLinks = new Map();
    if (savedLinks) {
      const parsedLinks = JSON.parse(savedLinks);
      if (Array.isArray(parsedLinks)) {
        if (typeof parsedLinks[0] === 'string') {
          parsedLinks.forEach(url => initialLinks.set(url, { competitorId: 0 }));
        } else {
          parsedLinks.forEach(([url, data]) => initialLinks.set(url, { competitorId: data.competitorId || 0 }));
        }
      }
    }
    return initialLinks;
  });
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState('priceAsc');
  const [connectionStatus, setConnectionStatus] = useState('Подключение...');
  const [activeTab, setActiveTab] = useState('all');
  const [newMyUrl, setNewMyUrl] = useState('');
  const [newCompetitorUrl, setNewCompetitorUrl] = useState('');
  const wsRef = useRef(null); // Ссылка на WebSocket для сохранения единственного экземпляра

  const categories = {
    all: 'Все',
    telescopes: 'Телескопы',
    kettles: 'Чайники',
    airfryers: 'Аэрогрили',
    grinders: 'Мельницы для специй',
    toothbrushes: 'Зубные щетки',
  };

  useEffect(() => {
    // Инициализация WebSocket
    if (!wsRef.current) {
      const wsConnection = new WebSocket(process.env.REACT_APP_WEBSOCKET_URL);
      wsRef.current = wsConnection;

      wsConnection.onopen = () => {
        console.log('WebSocket подключён');
        setConnectionStatus('Подключено');
        toast.success('WebSocket подключён', { autoClose: 3000 }); // Уведомление только один раз
        // Отправка начального списка ссылок
        wsConnection.send(JSON.stringify({ 
          action: 'updateLinks', 
          links: Array.from(productLinks).map(([url, data]) => ({ url, competitorId: data.competitorId }))
        }));
      };

      wsConnection.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log('Получено сообщение:', JSON.stringify(data, null, 2));

        if (data.error) {
          toast.error(`Ошибка от сервера: ${data.error}`);
          return;
        }

        if (data.action === 'remove') {
          setPrices((prev) => prev.filter((item) => item.url !== data.url));
          setProductLinks((prev) => {
            const newMap = new Map(prev);
            newMap.delete(data.url);
            return newMap;
          });
          toast.info(`Удалена ссылка: ${data.url}`);
          return;
        }

        if (data.action === 'add') {
          setProductLinks((prev) => {
            const newMap = new Map(prev);
            newMap.set(data.url, { competitorId: data.competitorId });
            return newMap;
          });
          toast.success(`Ссылка ${data.url} добавлена для мониторинга`);
          return;
        }

        if (data.action === 'priceChange') {
          setPrices((prev) => {
            const existingIndex = prev.findIndex((item) => item.url === data.url);
            if (existingIndex !== -1) {
              const updatedPrices = [...prev];
              const oldPrice = updatedPrices[existingIndex].newPrice;
              updatedPrices[existingIndex] = { ...data };
              if (oldPrice !== data.newPrice) {
                toast.warn(`${data.name}: Цена изменилась с ${oldPrice ?? 'N/A'} на ${data.newPrice} руб.`);
              }
              return updatedPrices;
            } else {
              return [...prev, { ...data }];
            }
          });
        }

        if (data.action === 'captchaDetected') {
          toast.error(`Капча обнаружена на ${data.url}. Данные временно недоступны.`);
        }
      };

      wsConnection.onerror = (error) => {
        console.error('Ошибка WebSocket:', error);
        setConnectionStatus('Ошибка подключения');
        toast.error('Ошибка подключения к WebSocket');
      };

      wsConnection.onclose = () => {
        console.log('WebSocket закрыт, пытаемся переподключиться...');
        setConnectionStatus('Переподключение...');
        wsRef.current = null; // Сбрасываем ссылку для повторного подключения
        setTimeout(() => {
          if (!wsRef.current) connectWebSocket(); // Повторная попытка подключения
        }, 5000);
      };
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []); // Пустая зависимость, чтобы useEffect срабатывал только при монтировании

  useEffect(() => {
    localStorage.setItem('prices', JSON.stringify(prices));
    localStorage.setItem('productLinks', JSON.stringify([...productLinks]));
  }, [prices, productLinks]);

  const myProducts = Array.from(productLinks).filter(([, data]) => data.competitorId === 0).map(([url]) => url);
  const competitorProducts = Array.from(productLinks).filter(([, data]) => data.competitorId === 1).map(([url]) => url);

  const filteredAndSortedPrices = useMemo(() => {
    let filtered = prices.filter((item) => {
      const matchesFilter = item.name.toLowerCase().includes(filter.toLowerCase());
      const matchesTab =
        activeTab === 'all' ||
        {
          telescopes: item.productName.toLowerCase().includes('телескоп') || item.productName.toLowerCase().includes('telescope'),
          kettles: item.productName.toLowerCase().includes('чайник') || item.productName.toLowerCase().includes('kettle'),
          airfryers: item.productName.toLowerCase().includes('аэрогрил') || item.productName.toLowerCase().includes('air fryer'),
          grinders: item.productName.toLowerCase().includes('мельница') || item.productName.toLowerCase().includes('grinder'),
          toothbrushes: item.productName.toLowerCase().includes('зубная щетка') || item.productName.toLowerCase().includes('toothbrush'),
        }[activeTab];
      return matchesFilter && matchesTab;
    });
  
    switch (sortBy) {
      case 'priceAsc':
        return [...filtered].sort((a, b) => (a.newPrice || 0) - (b.newPrice || 0));
      case 'priceDesc':
        return [...filtered].sort((a, b) => (b.newPrice || 0) - (a.newPrice || 0));
      case 'name':
        return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
      default:
        return filtered;
    }
  }, [prices, filter, sortBy, activeTab]);

  const myPrices = filteredAndSortedPrices.filter(item => myProducts.includes(item.url));
  const competitorPrices = filteredAndSortedPrices.filter(item => competitorProducts.includes(item.url));

  const renderCard = (item) => {
    const referencePrice = myPrices.find((p) => p.name.toLowerCase().includes('itime'))?.newPrice || item.newPrice;

    return (
      <div
        key={item.url}
        style={{
          padding: '5px',
          border: '1px solid #ccc',
          borderRadius: '5px',
          backgroundColor:
            item.name.toLowerCase().includes('itime')
              ? '#f8f9fa'
              : item.newPrice > referencePrice
              ? '#66b0ff'
              : item.newPrice < referencePrice
              ? '#ff6666'
              : '#ffffff',
          color: item.name.toLowerCase().includes('itime') ? '#333' : item.newPrice !== referencePrice ? '#000' : '#333',
          boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          minWidth: '150px',
          minHeight: '150px',
        }}
      >
        <div>
          <h3 style={{ margin: '0 0 3px 0', fontSize: '15px', color: 'inherit' }}>{item.name}</h3>
          <p style={{ margin: '3px 0', fontSize: '17px', color: 'inherit' }}>Товар: {item.productName}</p>
          <p style={{ margin: '3px 0', fontSize: '17px', color: 'inherit' }}>
            Старая цена: {item.oldPrice !== null && item.oldPrice !== undefined ? item.oldPrice.toLocaleString() : 'N/A'} руб.
          </p>
          <p style={{ margin: '3px 0', fontSize: '17px', color: 'inherit' }}>
            Новая цена: {item.newPrice !== null && item.newPrice !== undefined ? item.newPrice.toLocaleString() : 'N/A'} руб.
          </p>
          <p style={{ margin: '3px 0' }}>
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#000d55', textDecoration: 'none', fontSize: '15px' }}
              onMouseEnter={(e) => (e.target.style.textDecoration = 'underline')}
              onMouseLeave={(e) => (e.target.style.textDecoration = 'none')}
            >
              Перейти
            </a>
          </p>
        </div>
        <button
          onClick={() => {
            setPrices((prev) => prev.filter((p) => p.url !== item.url));
            setProductLinks((prev) => {
              const newMap = new Map(prev);
              newMap.delete(item.url);
              if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ action: 'remove', url: item.url }));
                wsRef.current.send(JSON.stringify({ 
                  action: 'updateLinks', 
                  links: Array.from(newMap).map(([url, data]) => ({ url, competitorId: data.competitorId })) 
                }));
              }
              return newMap;
            });
            toast.info(`Удалена ссылка: ${item.url}`);
          }}
          style={{
            marginTop: '5px',
            padding: '3px 5px',
            backgroundColor: '#ff4444',
            color: 'white',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '16px',
          }}
        >
          Удалить
        </button>
      </div>
    );
  };

  const handleAddMyUrl = () => {
    if (newMyUrl && !productLinks.has(newMyUrl) && newMyUrl.startsWith('https://www.farpost.ru/')) {
      setProductLinks((prev) => {
        const newMap = new Map(prev);
        newMap.set(newMyUrl, { competitorId: 0 });
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ action: 'add', url: newMyUrl, competitorId: 0 }));
        }
        return newMap;
      });
      setNewMyUrl('');
      toast.success(`Добавлена ссылка ${newMyUrl} для моих товаров`);
    } else {
      toast.error('Неверная или уже существующая ссылка. Убедитесь, что ссылка начинается с https://www.farpost.ru/');
    }
  };

  const handleAddCompetitorUrl = () => {
    if (newCompetitorUrl && !productLinks.has(newCompetitorUrl) && newCompetitorUrl.startsWith('https://www.farpost.ru/')) {
      setProductLinks((prev) => {
        const newMap = new Map(prev);
        newMap.set(newCompetitorUrl, { competitorId: 1 });
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ action: 'add', url: newCompetitorUrl, competitorId: 1 }));
        }
        return newMap;
      });
      setNewCompetitorUrl('');
      toast.success(`Добавлена ссылка ${newCompetitorUrl} для чужих товаров`);
    } else {
      toast.error('Неверная или уже существующая ссылка. Убедитесь, что ссылка начинается с https://www.farpost.ru/');
    }
  };

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const links = JSON.parse(e.target.result);
          if (!Array.isArray(links)) throw new Error('Файл должен содержать массив ссылок');
          const validLinks = links.filter(link => 
            link.url && 
            link.url.startsWith('https://www.farpost.ru/') && 
            !productLinks.has(link.url)
          );
          if (validLinks.length === 0) {
            toast.error('Нет новых валидных ссылок для добавления');
            return;
          }
          setProductLinks(prev => {
            const newMap = new Map(prev);
            validLinks.forEach(link => {
              newMap.set(link.url, { competitorId: link.competitorId || 0 });
            });
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({ action: 'updateLinks', links: validLinks }));
            }
            return newMap;
          });
          toast.success(`Добавлено ${validLinks.length} новых ссылок`);
        } catch (error) {
          toast.error(`Ошибка загрузки файла: ${error.message}`);
        }
      };
      reader.readAsText(file);
    }
  };

  return (
    <div style={{ padding: '20px', height: '100vh' }}>
      <h1>Мониторинг цен</h1>
      <div style={{ marginBottom: '10px' }}>
        <p>Статус подключения: {connectionStatus}</p>
      </div>
      <div style={{ marginBottom: '20px' }}>
        <div style={{ marginBottom: '10px' }}>
          {Object.entries(categories).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              style={{
                padding: '10px',
                marginRight: '10px',
                backgroundColor: activeTab === key ? '#007bff' : '#ccc',
                color: activeTab === key ? 'white' : 'black',
                border: 'none',
                borderRadius: '5px',
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Фильтр по магазину..."
          style={{ padding: '10px', width: '300px', marginRight: '10px' }}
        />
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          style={{ padding: '10px' }}
        >
          <option value="priceAsc">Сортировать по цене (по возрастанию)</option>
          <option value="priceDesc">Сортировать по цене (по убыванию)</option>
          <option value="name">Сортировать по названию магазина</option>
        </select>
        <div style={{ marginTop: '10px', display: 'flex', gap: '20px' }}>
          <div>
            <input
              type="text"
              value={newMyUrl}
              onChange={(e) => setNewMyUrl(e.target.value)}
              placeholder="URL для моих товаров..."
              style={{ padding: '10px', width: '400px', marginRight: '10px' }}
            />
            <button
              onClick={handleAddMyUrl}
              style={{ padding: '10px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}
            >
              Добавить мои товары
            </button>
          </div>
          <div>
            <input
              type="text"
              value={newCompetitorUrl}
              onChange={(e) => setNewCompetitorUrl(e.target.value)}
              placeholder="URL для чужих товаров..."
              style={{ padding: '10px', width: '400px', marginRight: '10px' }}
            />
            <button
              onClick={handleAddCompetitorUrl}
              style={{ padding: '10px', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer' }}
            >
              Добавить чужие товары
            </button>
          </div>
          <div>
            <input
              type="file"
              accept=".json"
              onChange={handleFileUpload}
              style={{ marginLeft: '10px' }}
            />
            <label style={{ marginLeft: '5px' }}>Загрузить список ссылок (JSON)</label>
          </div>
        </div>
      </div>
      {productLinks.size === 0 ? (
        <p>Добавьте ссылки на товары с Farpost, чтобы начать мониторинг цен.</p>
      ) : filteredAndSortedPrices.length === 0 ? (
        <p>Ожидание данных. Цены обновляются каждые 6 часов.</p>
      ) : (
        <div style={{ display: 'flex', gap: '20px' }}>
          <div style={{ flex: 1 }}>
            <h2>Мои товары</h2>
            {myPrices.length === 0 ? (
              <p>Нет данных о моих товарах.</p>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
                  gap: '30px',
                  paddingBottom: '20px',
                  overflowY: 'auto',
                }}
              >
                {myPrices.map((item) => renderCard(item))}
              </div>
            )}
          </div>
          <div
            style={{
              width: '2px',
              backgroundColor: '#007bff',
              alignSelf: 'stretch',
            }}
          />
          <div style={{ flex: 1 }}>
            <h2>Чужие товары</h2>
            {competitorPrices.length === 0 ? (
              <p>Нет данных о чужих товарах.</p>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
                  gap: '30px',
                  paddingBottom: '20px',
                  overflowY: 'auto',
                }}
              >
                {competitorPrices.map((item) => renderCard(item))}
              </div>
            )}
          </div>
        </div>
      )}
      <ToastContainer />
    </div>
  );
}

export default App;