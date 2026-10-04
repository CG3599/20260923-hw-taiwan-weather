const API_URL="/api/weather";
const state={rows:[],selectedCity:"",selectedTown:"",selectedDate:"",routeDate:"",forecastDates:[],defaultLocations:[],suggestionItems:[],suggestionIndex:-1};
const DEFAULT_KEY="weatherDefaultLocations";
let cartoBasemapKey=(window.__CARTO_CONFIG__&&window.__CARTO_CONFIG__.key)||"";
let routeLoadingTimer=null;
function loadCartoBasemapKey(){
  if(!cartoBasemapKey)throw new Error("CARTO_API_KEY 尚未設定。");
  return cartoBasemapKey;
}

const $=s=>document.querySelector(s);

function icon(t=""){if(t.includes("雷"))return"⛈️";if(t.includes("雨"))return"🌧️";if(t.includes("雪"))return"❄️";if(t.includes("霧"))return"🌫️";if(t.includes("晴時多雲"))return"🌤️";if(t.includes("晴"))return"☀️";if(t.includes("多雲"))return"⛅";if(t.includes("陰"))return"☁️";return"🌈"}
function num(v){if(v==null||v===""||v==="--"||v==="無資料")return null;const n=Number(v);return Number.isFinite(n)?n:null}
function windArrow(direction=""){const d=String(direction);if(d.includes("北北東")||d.includes("東北"))return"↗️";if(d.includes("東南")||d.includes("南東"))return"↘️";if(d.includes("南西")||d.includes("西南"))return"↙️";if(d.includes("西北")||d.includes("北西"))return"↖️";if(d.includes("東"))return"➡️";if(d.includes("南"))return"⬇️";if(d.includes("西"))return"⬅️";if(d.includes("北"))return"⬆️";return"🧭"}

function parseRows(data){
  // SQLite API 回傳的是扁平化的 Locations rows；
  // 舊版 CWA API 則是「縣市 -> Location -> WeatherElement」巢狀格式。
  if(data?.source==="SQLite"){
    const records=data?.records?.Locations||[];
    const groups=new Map();
    for(const r of records){
      const key=(r?.city||"未知縣市")+"||"+(r?.town||"未知鄉鎮");
      if(!groups.has(key)){
        groups.set(key,{
          city:r?.city||"未知縣市",
          town:r?.town||"未知鄉鎮",
          latitude:num(r?.latitude),
          longitude:num(r?.longitude),
          forecast:[]
        });
      }
      groups.get(key).forecast.push({
        city:r?.city||"未知縣市",
        town:r?.town||"未知鄉鎮",
        latitude:num(r?.latitude),
        longitude:num(r?.longitude),
        temperature:num(r?.temperature),
        humidity:num(r?.humidity),
        pop:num(r?.pop),
        windDirection:r?.wind_direction??"--",
        windSpeed:num(r?.wind_speed),
        weather:r?.weather??"資料待更新",
        start:r?.forecast_time||""
      });
    }
    return [...groups.values()].map(g=>{
      g.forecast.sort((a,b)=>new Date(a.start)-new Date(b.start));
      const now=Date.now();
      const current=g.forecast.reduce((best,r)=>{
        if(!best)return r;
        return Math.abs(new Date(r.start)-now)<Math.abs(new Date(best.start)-now)?r:best;
      },g.forecast[0]||null);
      const row=current||{
        city:g.city,town:g.town,latitude:g.latitude,longitude:g.longitude,
        temperature:null,humidity:null,pop:null,windDirection:"--",windSpeed:null,weather:"資料待更新",start:""
      };
      row.forecast=g.forecast;
      row.city=g.city; row.town=g.town; row.latitude=g.latitude; row.longitude=g.longitude;
      const riding=ridingCondition(row);
      return {...row,riding};
    });
  }
  // 保留舊版 CWA 原始資料格式解析能力。
  const groups=data?.records?.Locations||[],rows=[];
  for(const group of groups){
    const city=group?.LocationsName||"未知縣市";
    for(const l of group?.Location||[]){
      const es=l?.WeatherElement||[];
      const find=(...names)=>es.find(x=>names.includes(x.ElementName));
      const temperatureEl=find("溫度","Temperature");
      const humidityEl=find("相對濕度","RelativeHumidity");
      const popEl=find("3小時降雨機率","3小時降雨機率（%）","降雨機率","ProbabilityOfPrecipitation","3-hour ProbabilityOfPrecipitation");
      const windDirectionEl=find("風向","WindDirection");
      const windSpeedEl=find("風速","WindSpeed");
      const weatherEl=find("天氣現象","Weather");
      const timeKeys=new Set([
        ...(temperatureEl?.Time||[]).map(t=>t.StartTime||t.DataTime).filter(Boolean),
        ...(weatherEl?.Time||[]).map(t=>t.StartTime||t.DataTime).filter(Boolean)
      ]);
      const valueAt=(element,key)=>{
        const item=(element?.Time||[]).find(t=>(t.StartTime||t.DataTime)===key);
        return item?.ElementValue?.[0]||{};
      };
      const valueFrom=(v,names)=>{
        for(const name of names){
          if(v?.[name]!=null)return v[name];
        }
        return Object.values(v||{})[0];
      };
      const times=new Map();
      for(const key of timeKeys){
        const tv=valueAt(temperatureEl,key),hv=valueAt(humidityEl,key),pv=valueAt(popEl,key),wv=valueAt(windDirectionEl,key),ws=valueAt(windSpeedEl,key),xv=valueAt(weatherEl,key);
        const r={
          city,town:l?.LocationName||"未知鄉鎮",latitude:num(l?.Latitude),longitude:num(l?.Longitude),
          temperature:num(valueFrom(tv,["溫度","Temperature"])),
          humidity:num(valueFrom(hv,["相對濕度","RelativeHumidity"])),
          pop:num(valueFrom(pv,["ProbabilityOfPrecipitation","3小時降雨機率","3小時降雨機率（%）"])),
          windDirection:valueFrom(wv,["風向","WindDirection"])??"--",
          windSpeed:num(valueFrom(ws,["風速","WindSpeed"])),
          weather:valueFrom(xv,["天氣現象","Weather"])??"資料待更新",
          start:key
        };
        times.set(key,r);
      }
      const forecast=[...times.values()].sort((a,b)=>new Date(a.start)-new Date(b.start));
      const current=forecast[0]||{
        city,town:l?.LocationName||"未知鄉鎮",latitude:num(l?.Latitude),longitude:num(l?.Longitude),
        temperature:null,humidity:null,pop:null,windDirection:"--",windSpeed:null,weather:"資料待更新",start:""
      };
      current.forecast=forecast;
      rows.push(current);
    }
  }
  return rows.map(r=>{
    const riding=ridingCondition(r);
    return {...r,riding};
  });
}
function buildDecisionSupport(r){
  const riding=r?.riding||ridingCondition(r);
  const reasons=riding.reasons||[];
  let action="EXECUTE";
  let actionLabel="可出發";
  let actionIcon="🟢";
  if(riding.level==="high"){
    action="WAIT"; actionLabel="建議等待"; actionIcon="🔴";
  }else if(riding.level==="caution"){
    action="ASK"; actionLabel="出發前再次確認"; actionIcon="🟠";
  }else if(riding.level==="normal"){
    action="ASK"; actionLabel="建議確認天氣"; actionIcon="🟡";
  }
  const evidence=[
    Number.isFinite(r.temperature)?("溫度 "+fmt(r.temperature," °C")):null,
    Number.isFinite(r.humidity)?("濕度 "+fmt(r.humidity," %")):null,
    Number.isFinite(r.pop)?("降雨機率 "+fmt(r.pop," %")):"降雨機率：資料缺失",
    Number.isFinite(r.windSpeed)?("風速 "+fmt(r.windSpeed," m/s")):"風速：資料缺失"
  ].filter(Boolean);
  return {
    action,actionLabel,actionIcon,score:riding.score,reasons,evidence,
    advice:riding.advice,rainGear:riding.rainGear,rainRisk:riding.rainRisk
  };
}

function ridingAdvice(condition){
  const reasons=condition?.reasons||[];
  const level=condition?.level;
  const temperatureAlert=condition?.temperatureAlert||"";
  const addTemperatureAlert=message=>temperatureAlert?temperatureAlert+" "+message:message;
  if(condition?.rainGear==="強烈建議攜帶"){
    return addTemperatureAlert("降雨風險較高，建議攜帶雨具並在出發前再次確認最新天氣。");
  }
  if(level==="high"){
    return addTemperatureAlert("目前騎乘條件較不利，出發前請重新確認最新天氣資訊，並留意降雨與風勢。");
  }
  if(level==="caution"){
    if(reasons.some(x=>x.includes("降雨")||x.includes("陣雨")||x.includes("雷雨")||x.includes("大雨")||x.includes("豪雨"))){
      return addTemperatureAlert("騎乘時需留意降雨，建議攜帶雨具並持續確認天氣變化。");
    }
    if(reasons.includes("風速強")||reasons.includes("風速偏強")||reasons.includes("風速較高")){
      return addTemperatureAlert("騎乘時需留意風勢，經過橋梁、開闊路段時請特別注意。");
    }
    return addTemperatureAlert("目前騎乘條件需注意，建議出發前再次確認天氣與路況。");
  }
  if(level==="normal"){
    return condition?.rainGear==="建議攜帶"
      ? addTemperatureAlert("整體騎乘條件尚可，但有降雨可能，建議攜帶雨具並持續留意天氣。")
      : addTemperatureAlert("整體騎乘條件尚可，仍建議持續留意降雨與風勢變化。");
  }
  return condition?.rainGear==="建議攜帶"
    ? addTemperatureAlert("目前騎乘條件穩定，但仍有降雨可能，建議攜帶雨具。")
    : addTemperatureAlert("目前天氣條件較穩定，適合一般騎乘；出發前仍可確認最新天氣資訊。");
}

function classifyRainRisk(pop,weather){
  const text=String(weather||"").replaceAll("臺","台");
  let weatherLevel=0;
  if(/大豪雨|豪雨|強烈雷雨/.test(text))weatherLevel=4;
  else if(/雷雨|雷陣雨|大雨|強陣雨/.test(text))weatherLevel=3;
  else if(/短暫雨|短暫陣雨|午後.*陣雨|陣雨|有雨|降雨|持續降雨/.test(text))weatherLevel=1;
  let popLevel=null;
  if(Number.isFinite(pop)){
    if(pop>=90)popLevel=4;
    else if(pop>=70)popLevel=3;
    else if(pop>=50)popLevel=2;
    else if(pop>=20)popLevel=1;
    else popLevel=0;
  }
  const riskLevel=Math.max(weatherLevel,popLevel==null?0:popLevel);
  const penalty=Math.min(4,riskLevel);
  let rainRisk="低";
  if(riskLevel>=4)rainRisk="極高";
  else if(riskLevel>=3)rainRisk="高";
  else if(riskLevel>=2)rainRisk="中高";
  else if(riskLevel>=1)rainRisk="中";
  let rainGear="不需特別準備";
  if(riskLevel>=4)rainGear="強烈建議攜帶";
  else if(riskLevel>=2)rainGear="建議攜帶";
  else if(riskLevel===1)rainGear=(weatherLevel>=1||popLevel>=1)?"建議攜帶":"可考慮攜帶";
  return {riskLevel,penalty,rainRisk,rainGear,weatherLevel,popLevel};
}

function ridingCondition(r){
  const temp=num(r?.temperature);
  const humidity=num(r?.humidity);
  const wind=num(r?.windSpeed);
  const pop=num(r?.pop);
  const weather=String(r?.weather||"");
  let score=5;
  const reasons=[];
  const missing=[];

  const rain=classifyRainRisk(pop,weather);
  if(rain.penalty>0){
    if(rain.popLevel>=4)reasons.push("降雨機率極高");
    else if(rain.popLevel===3)reasons.push("降雨機率高");
    else if(rain.popLevel===2)reasons.push("降雨機率偏高");
    else if(rain.popLevel===1)reasons.push("有降雨可能");
    if(rain.weatherLevel>=4)reasons.push("嚴重降雨");
    else if(rain.weatherLevel===3)reasons.push("雷雨或強降雨");
    else if(rain.weatherLevel===1 && !/晴時多雲|多雲/.test(weather))reasons.push("可能出現陣雨");
  }
  if(!Number.isFinite(pop))missing.push("降雨機率資料缺失");

  let windPenalty=0;
  if(Number.isFinite(wind)){
    if(wind>=13){windPenalty=4;reasons.push("強風");}
    else if(wind>=10){windPenalty=3;reasons.push("風速強");}
    else if(wind>=7){windPenalty=2;reasons.push("風速偏強");}
    else if(wind>=5){windPenalty=1;reasons.push("風速較高");}
  }else{
    missing.push("風速資料缺失");
  }

  // 溫度不列入騎乘適合度評分，僅作為獨立提醒。
  let tempPenalty=0;
  let temperatureAlert="";
  if(Number.isFinite(temp)){
    if(temp>=35)temperatureAlert="🌡️ 高溫提醒：目前氣溫偏高，長時間騎乘請注意補充水分、防曬與適度休息。";
    else if(temp>=33)temperatureAlert="🌡️ 高溫提醒：目前氣溫偏高，騎乘時請注意補充水分與防曬。";
    else if(temp<=10)temperatureAlert="🥶 低溫提醒：目前氣溫偏低，騎乘時請注意保暖，並留意長時間曝露於低溫環境。";
    else if(temp<15)temperatureAlert="🥶 低溫提醒：目前氣溫偏低，騎乘時請注意保暖。";
  }else{
    missing.push("溫度資料缺失");
  }

  let humidityPenalty=0;
  if(Number.isFinite(humidity)){
    if(humidity>=90){humidityPenalty=1;reasons.push("濕度高");}
    else if(humidity>=85){humidityPenalty=1;reasons.push("濕度偏高");}
  }else{
    missing.push("濕度資料缺失");
  }

  const availableFactors=[temp,humidity,wind,pop].filter(Number.isFinite).length;
  if(missing.length)reasons.push("部分氣象資料缺失，評分僅依目前可用資料估算");

  const incomplete=availableFactors===0;
  if(incomplete){
    return {
      score:null,level:"normal",label:"資料不足",icon:"🟡",
      reasons:reasons.length?reasons:["目前沒有可用的騎乘評估資料"],
      missing,incomplete:true,weatherRisk:false,rainRisk:rain.rainRisk,rainGear:rain.rainGear,
      rainPenalty:rain.penalty,advice:"目前缺少可用的氣象資料，暫時無法估算騎乘條件。"
    };
  }

  score-=rain.penalty+windPenalty+tempPenalty+humidityPenalty;

  // 主要不利因素同時出現時，避免單項扣分不足以反映整體騎乘環境。
  const majorFactors=[
    rain.riskLevel>=1,
    windPenalty>=1
  ].filter(Boolean).length;
  if(majorFactors>=3){
    score=Math.min(score,2);
    reasons.push("多項主要不利因素同時存在");
  }else if(majorFactors>=2){
    score=Math.min(score,3);
    reasons.push("同時存在多項不利因素");
  }

  // 嚴重降雨／雷雨設定最高分，避免其他舒適條件抵銷明顯的降雨風險。
  if(rain.weatherLevel>=4)score=Math.min(score,1);
  else if(rain.weatherLevel===3)score=Math.min(score,2);
  else if(rain.weatherLevel===1)score=Math.min(score,4);

  score=Math.max(0,Math.min(5,score));

  let level="good",label="良好",icon="🟢";
  if(score<=1){level="high";label="高風險";icon="🔴";}
  else if(score===2){level="caution";label="需注意";icon="🟠";}
  else if(score===3){level="normal";label="普通";icon="🟡";}

  const condition={
    score,level,label,icon,reasons,missing,incomplete:false,
    weatherRisk:rain.riskLevel>=2,rainRisk:rain.rainRisk,rainGear:rain.rainGear,
    rainPenalty:rain.penalty,temperatureAlert
  };
  condition.advice=missing.length
    ? "目前以已取得的氣象資料估算騎乘條件；部分資料缺失，結果可能存在誤差。"
    : ridingAdvice(condition);
  return condition;
}
function ridingLevel(score){
  if(score<=1)return {level:"high",label:"高風險",icon:"🔴"};
  if(score===2)return {level:"caution",label:"需注意",icon:"🟠"};
  if(score===3)return {level:"normal",label:"普通",icon:"🟡"};
  return {level:"good",label:"良好",icon:"🟢"};
}

function fmt(v,s=""){return v==null?"--":(Number.isInteger(v)?v:v.toFixed(1))+s}
function taiwanDateKey(value){
  const d=new Date(value);
  if(Number.isNaN(d.getTime()))return "";
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
}
function todayTaiwan(){
  return taiwanDateKey(new Date());
}
function availableForecastDates(){
  if(state.forecastDates.length)return state.forecastDates.slice(0,7);
  const set=new Set();
  state.rows.forEach(r=>(r.forecast||[]).forEach(item=>{
    const key=taiwanDateKey(item.start);
    if(key)set.add(key);
  }));
  state.forecastDates=[...set].sort().slice(0,7);
  return state.forecastDates;
}
function formatForecastDate(key){
  if(!key)return "";
  const d=new Date(key+"T00:00:00+08:00");
  if(Number.isNaN(d.getTime()))return key;
  const month=String(d.getMonth()+1).padStart(2,"0");
  const day=String(d.getDate()).padStart(2,"0");
  const weekday=["日","一","二","三","四","五","六"][d.getDay()];
  return month+"/"+day+" (週"+weekday+")";
}
function formatTaiwanDateTime(value){
  const d=value instanceof Date?value:new Date(value);
  if(Number.isNaN(d.getTime()))return "--";
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(d);
  const get=t=>parts.find(p=>p.type===t)?.value||"00";
  return get("year")+"/"+get("month")+"/"+get("day")+" "+get("hour")+":"+get("minute")+":"+get("second");
}
function rowForDate(r,dateKey=state.selectedDate){
  if(!r)return null;
  const items=(r.forecast||[]).filter(x=>taiwanDateKey(x.start)===dateKey);
  if(!items.length)return null;
  const target=new Date(dateKey+"T12:00:00+08:00").getTime();
  return items.slice().sort((a,b)=>Math.abs(new Date(a.start).getTime()-target)-Math.abs(new Date(b.start).getTime()-target))[0]||items[0];
}
function selectedRows(rows=state.rows){
  const dateKey=state.selectedDate||todayTaiwan();
  return rows.map(r=>rowForDate(r,dateKey)).filter(Boolean).map(x=>{
    const base=state.rows.find(r=>r.city===x.city&&r.town===x.town)||x;
    return {...x,forecast:base.forecast||x.forecast};
  });
}
function populateForecastDateSelect(){
  const sel=$("#forecastDateSelect");
  if(!sel)return;
  const dates=availableForecastDates();
  const today=todayTaiwan();
  state.selectedDate=dates.includes(state.selectedDate)?state.selectedDate:(dates.includes(today)?today:(dates[0]||""));
  sel.innerHTML=dates.map(key=>'<option value="'+key+'">'+formatForecastDate(key)+'</option>').join("");
  sel.value=state.selectedDate;
}
function refreshSelectedDateView(){
  const rows=selectedRows();
  if(state.selectedCity&&state.selectedTown){
    const r=rows.find(x=>x.city===state.selectedCity&&x.town===state.selectedTown);
    if(r)renderRows([r],false);
    else renderDefaultCards();
  }else if(state.selectedCity){
    renderCityCards(state.selectedCity);
  }else{
    renderDefaultCards();
  }
  lazyLoadTaiwanMap();
}
function cities(){return [...new Set(state.rows.map(r=>r.city))]}
function towns(city){return state.rows.filter(r=>r.city===city).sort((a,b)=>a.town.localeCompare(b.town,"zh-Hant"))}
function cityRepresentative(city){const rs=towns(city);return rs[0]||null}
function routeOptionValue(r){return r.city+"||"+r.town}
function routeDateValue(){const dates=availableForecastDates();if(!dates.length)return todayTaiwan();if(!state.routeDate||!dates.includes(state.routeDate))state.routeDate=dates.includes(todayTaiwan())?todayTaiwan():dates[0];return state.routeDate;}
function routeWeatherRow(r){return rowForDate(r,routeDateValue())||r;}
function findRouteRow(value){const [city,town]=String(value||"").split("||");const base=state.rows.find(r=>r.city===city&&r.town===town)||null;return base?routeWeatherRow(base):null;}
function populateRouteDateSelect(){const sel=$("#routeDateSelect");if(!sel)return;const dates=availableForecastDates();state.routeDate=dates.includes(state.routeDate)?state.routeDate:(dates.includes(todayTaiwan())?todayTaiwan():(dates[0]||""));sel.innerHTML=dates.map(key=>'<option value="'+key+'">'+formatForecastDate(key)+(key===todayTaiwan()?" · 今天":"")+'</option>').join("");sel.value=state.routeDate;}
function populateRouteSelects(){
  const options=state.rows.filter(r=>Number.isFinite(r.latitude)&&Number.isFinite(r.longitude)).slice().sort((a,b)=>(a.city+a.town).localeCompare(b.city+b.town,"zh-Hant"));
  const html='<option value="">請選擇地點</option>'+options.map(r=>'<option value="'+routeOptionValue(r).replaceAll('"','&quot;')+'">'+r.city+"｜"+r.town+"</option>").join("");
  ["#routeFrom","#routeTo"].forEach(sel=>{const el=$(sel);if(el)el.innerHTML=html;});
  setupRouteSearch("from"); setupRouteSearch("to");
}
function routeSearchElements(side){
  const cap=side==="from"?"From":"To";
  return {input:$("#route"+cap+"Search"),suggestions:$("#route"+cap+"Suggestions"),townWrap:$("#route"+cap+"TownWrap"),town:$("#route"+cap+"Town"),value:$("#route"+cap)};
}
function populateRouteTown(side,city,selected=""){
  const el=routeSearchElements(side).town;
  el.innerHTML='<option value="">請選擇鄉鎮</option>';
  towns(city).filter(r=>Number.isFinite(r.latitude)&&Number.isFinite(r.longitude)).forEach(r=>{const o=document.createElement("option");o.value=routeOptionValue(r);o.textContent=r.town;if(r.town===selected)o.selected=true;el.appendChild(o);});
}
function focusNextRouteField(side){
  setTimeout(()=>{
    if(side==="from"){
      const next=$("#routeToSearch");
      if(next)next.focus();
    }else{
      const button=$("#analyzeRouteBtn");
      if(button)button.focus();
    }
  },0);
}
function focusRouteTown(side){
  setTimeout(()=>{
    const town=routeSearchElements(side).town;
    if(town)town.focus();
  },0);
}
function setRouteLocation(side,r){
  const e=routeSearchElements(side); if(!r)return;
  e.value.value=routeOptionValue(r); e.input.value=r.town;
  e.townWrap.classList.add("hidden"); e.suggestions.classList.add("hidden");
  focusNextRouteField(side);
}
function renderRouteSuggestions(side){
  const e=routeSearchElements(side),q=normalizeSearchText(e.input.value);
  e.suggestions.innerHTML="";
  if(!q){e.suggestions.classList.add("hidden");e.townWrap.classList.add("hidden");return;}
  const cityMatches=cities().filter(c=>normalizeSearchText(c).includes(q));
  const townMatches=state.rows.filter(r=>Number.isFinite(r.latitude)&&Number.isFinite(r.longitude)&&normalizeSearchText(r.town).includes(q));
  const exactCity=cities().find(c=>normalizeSearchText(c)===q);
  if(exactCity){
    e.suggestions.classList.add("hidden");e.townWrap.classList.remove("hidden");populateRouteTown(side,exactCity);
    e.input.dataset.city=exactCity;e.input.dataset.mode="city";e.value.value="";
    focusRouteTown(side);
    return;
  }
  const items=[],seen=new Set();
  cityMatches.forEach(city=>{if(!seen.has(city)){seen.add(city);items.push({type:"city",city,town:"",name:city,label:"縣市"});}});
  townMatches.forEach(r=>items.push({type:"town",city:r.city,town:r.town,name:r.town,label:"鄉鎮"}));
  items.slice(0,10).forEach(m=>{const b=document.createElement("button");b.type="button";b.className="suggestion";b.innerHTML="<span>"+m.name+"</span><small>"+m.label+(m.type==="town"?"｜"+m.city:"")+"</small>";b.addEventListener("click",()=>selectRouteSearch(side,m));e.suggestions.appendChild(b);});
  e.suggestions.classList.toggle("hidden",!items.length);
  e.townWrap.classList.add("hidden");
}
function selectRouteSearch(side,m){
  const e=routeSearchElements(side); e.input.dataset.city=m.city;
  if(m.type==="town"){const r=findRouteRow(routeOptionValue({city:m.city,town:m.town}));setRouteLocation(side,r);return;}
  e.input.value=m.city;e.input.dataset.mode="city";e.value.value="";populateRouteTown(side,m.city);e.townWrap.classList.remove("hidden");e.suggestions.classList.add("hidden");
  focusRouteTown(side);
}
function setupRouteSearch(side){
  const e=routeSearchElements(side); if(!e.input||e.input.dataset.ready)return;
  e.input.dataset.ready="1";
  e.input.dataset.index="-1";
  e.input.addEventListener("input",()=>{e.input.dataset.index="-1";renderRouteSuggestions(side);});
  e.input.addEventListener("keydown",e2=>handleRouteSearchKeydown(side,e2));
  e.town.addEventListener("keydown",e2=>{
    if(e2.key==="Enter"&&e2.target.value){
      const r=findRouteRow(e2.target.value);
      if(r){setRouteLocation(side,r);e2.preventDefault();}
    }
  });
  e.town.addEventListener("change",()=>{const r=findRouteRow(e.town.value);if(r)setRouteLocation(side,r);});
}
function routeSuggestionButtons(side){
  return [...routeSearchElements(side).suggestions.querySelectorAll(".suggestion")];
}
function setRouteSuggestionIndex(side,index){
  const e=routeSearchElements(side),buttons=routeSuggestionButtons(side);
  if(!buttons.length)return;
  const next=Math.max(0,Math.min(index,buttons.length-1));
  e.input.dataset.index=String(next);
  buttons.forEach((el,i)=>el.classList.toggle("active",i===next));
  buttons[next]?.scrollIntoView({block:"nearest"});
}
function handleRouteSearchKeydown(side,event){
  const e=routeSearchElements(side),box=e.suggestions;
  if(event.key==="Escape"){
    box.classList.add("hidden");
    e.input.dataset.index="-1";
    return;
  }
  const buttons=routeSuggestionButtons(side);
  if(box.classList.contains("hidden")||!buttons.length){
    if((event.key==="ArrowDown"||event.key==="ArrowUp")&&e.input.value){
      renderRouteSuggestions(side);
      event.preventDefault();
      setRouteSuggestionIndex(side,event.key==="ArrowDown"?0:routeSuggestionButtons(side).length-1);
    }
    return;
  }
  const current=Number(e.input.dataset.index||"-1");
  if(event.key==="ArrowDown"){
    event.preventDefault();
    setRouteSuggestionIndex(side,current<0?0:current+1);
  }else if(event.key==="ArrowUp"){
    event.preventDefault();
    setRouteSuggestionIndex(side,current<0?buttons.length-1:current-1);
  }else if(event.key==="Enter"){
    event.preventDefault();
    const index=current<0?0:current;
    const items=buttons[index];
    if(items)items.click();
  }
}

function routeStepText(step){
  return [step?.ref,step?.name,step?.destinations,step?.exits].filter(Boolean).join(" ");
}
/*
 * 路線「道路可達性」分組。
 *
 * 重要：縣市相同 ≠ 一定存在道路連線。
 * 例如：
 *   澎湖縣七美鄉 ↔ 澎湖縣馬公市：中間是海，必須搭船／飛機，不能算道路路線。
 *   連江縣南竿鄉 ↔ 北竿鄉：必須搭船／飛機，不能算道路路線。
 *
 * 因此這裡不再用「縣市」當作唯一的 routing guard，而是用「實際道路島群」。
 * 只有同一個道路島群才允許進入 OSRM / Valhalla。
 */
const ROUTE_ISLAND_GROUPS=Object.freeze({
  main:"台灣本島",
  kinmen:"金門本島＋烈嶼（已有金門大橋道路連線）",
  penghuMain:"澎湖本島道路群（馬公／湖西／白沙／西嶼）",
  penghuWangan:"澎湖－望安島",
  penghuQimei:"澎湖－七美島",
  taitungMain:"台東本島",
  taitungGreen:"台東－綠島",
  taitungLanyu:"台東－蘭嶼",
  lienchiangNangan:"馬祖－南竿",
  lienchiangBeigan:"馬祖－北竿",
  lienchiangDongyin:"馬祖－東引",
  lienchiangJuguang:"馬祖－莒光"
});
const ROUTE_ISLAND_COUNTIES=Object.freeze({
  kinmen:"金門縣",
  penghu:"澎湖縣",
  lienchiang:"連江縣",
  taitung:"台東縣"
});

function routeIslandGroup(row){
  if(!row||!row.city)return "main";
  const city=String(row.city).replaceAll("臺","台");
  const town=String(row.town||"").replaceAll("臺","台");

  // 金門本島與烈嶼已由金門大橋形成道路連線，因此視為同一道路島群。
  if(city==="金門縣")return "kinmen";

  // 澎湖：馬公、湖西、白沙、西嶼屬可由道路／橋梁連接的道路群；
  // 望安、七美是不同島嶼，兩者到馬公都需要海空交通。
  if(city==="澎湖縣"){
    if(town==="七美鄉")return "penghuQimei";
    if(town==="望安鄉")return "penghuWangan";
    return "penghuMain";
  }

  // 台東縣：台東市、成功、池上、關山、鹿野、太麻里等台灣本島地區
  // 與其他本島縣市屬於同一條道路島群；只有綠島、蘭嶼是獨立離島道路群。
  if(city==="台東縣"){
    if(town==="綠島鄉")return "taitungGreen";
    if(town==="蘭嶼鄉")return "taitungLanyu";
    return "main";
  }

  // 連江縣：四個行政鄉並不是同一道路網。
  // 南竿、北竿、東引、莒光之間都必須透過海空交通。
  if(city==="連江縣"){
    if(town==="南竿鄉")return "lienchiangNangan";
    if(town==="北竿鄉")return "lienchiangBeigan";
    if(town==="東引鄉")return "lienchiangDongyin";
    if(town==="莒光鄉")return "lienchiangJuguang";
    return "lienchiangNangan";
  }

  return "main";
}
function routeRegionPolicy(from,to){
  const a=routeIslandGroup(from),b=routeIslandGroup(to);
  if(a===b){
    return {allowed:true,group:a,label:ROUTE_ISLAND_GROUPS[a]};
  }

  const aCity=String(from?.city||"").replaceAll("臺","台");
  const bCity=String(to?.city||"").replaceAll("臺","台");
  const sameCounty=aCity===bCity;

  return {
    allowed:false,
    group:a,
    label:"不可跨道路島群連線",
    message:sameCounty
      ? aCity+"內的這兩個地區沒有純道路連線，必須搭乘船舶或飛機；RideSky 不會把海運／空運當成道路路線。"
      : "起點與終點不在同一道路島群，兩地之間沒有純道路連線；RideSky 不會把海運／空運當成道路路線。"
  };
}
function routeRegionReminder(from,to){
  const p=routeRegionPolicy(from,to);
  if(p.allowed){
    if(p.group==="main")return "🛣️ 台灣本島道路路線";
    return "🏝️ "+p.label+"：僅分析島群內道路";
  }
  return "🚢 "+p.message;
}
const RIDESKY_FIXED_ROUTE_ORIGINS={
  "基隆市||七堵區":{
    name:"七堵車站",
    address:"基隆市七堵區長興里東新街2號",
    latitude:25.09294,
    longitude:121.71415,
    source:"七堵車站公開座標資料"
  }
};
function isQiduRow(row){
  return String(row?.city||"").replaceAll("臺","台")==="基隆市" &&
    String(row?.town||"").replaceAll("臺","台")==="七堵區";
}
function fixedRouteOrigin(row){
  if(!isQiduRow(row))return null;
  const p=RIDESKY_FIXED_ROUTE_ORIGINS["基隆市||七堵區"];
  return {
    latitude:p.latitude,
    longitude:p.longitude,
    city:row.city,
    town:row.town,
    fixedOriginName:p.name,
    fixedOriginAddress:p.address
  };
}
function routeLocationObject(row){
  return fixedRouteOrigin(row)||{
    latitude:Number(row.latitude),longitude:Number(row.longitude),city:row.city,town:row.town
  };
}
function routeHasForbiddenNationalMain(route){
  const steps=(route?.legs||[]).flatMap(leg=>leg?.steps||[]);
  const nationalPattern=/國道\s*(1|2|3|4|5|6|7|8|9|10)\s*(號|線)?/;
  return steps.some(step=>{
    const text=routeStepText(step).replaceAll("臺","台");
    if(/國道\s*甲/.test(text))return false;
    if(nationalPattern.test(text))return true;
    if(/(?:中山高速公路|福爾摩沙高速公路|北二高|二高|蔣渭水高速公路|北宜高速公路|水沙連高速公路|高速公路)/.test(text))return true;
    if(step?.road_classification?.motorway_class===true)return true;
    const ref=String(step?.ref||"").replaceAll("臺","台").trim();
    if(/^國道\s*(1|2|3|4|5|6|7|8|9|10)\s*(號|線)?$/.test(ref))return true;
    return false;
  });
}
function routePolicyLabel(route){
  const nationalBlocked=routeHasForbiddenNationalMain(route);
  return nationalBlocked
    ? "⚠️ 路線仍包含國道主線"
    : "🚫 已啟用：避開國道主線（國道甲線保留）";
}
function haversineKm(a,b){
  const R=6371;
  const p1=a[0]*Math.PI/180,p2=b[0]*Math.PI/180;
  const dp=(b[0]-a[0])*Math.PI/180,dl=(b[1]-a[1])*Math.PI/180;
  const x=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function routeLevel(score){return ridingLevel(score)}
function routeDecision(level){
  if(level==="high")return {icon:"🔴",label:"建議等待"};
  if(level==="caution")return {icon:"🟠",label:"出發前再次確認"};
  if(level==="normal")return {icon:"🟡",label:"建議確認天氣"};
  return {icon:"🟢",label:"可騎乘"};
}
function sampleRoutePoints(coords,count=30){
  if(!coords.length)return [];
  const n=Math.min(count,coords.length),out=[];
  if(n===1)return [coords[0]];
  for(let i=0;i<n;i++){
    const index=Math.round(i*(coords.length-1)/(n-1));
    out.push(coords[index]);
  }
  return out;
}
function nearestWeatherRow(lat,lon){
  let best=null,bestDistance=Infinity;
  for(const r of state.rows){
    if(!Number.isFinite(r.latitude)||!Number.isFinite(r.longitude))continue;
    const d=haversineKm([lat,lon],[r.latitude,r.longitude]);
    if(d<bestDistance){bestDistance=d;best=r;}
  }
  return best?{row:best,distance:bestDistance}:null;
}
function routeClass(level){return level==="high"?"route-high":level==="caution"?"route-caution":level==="normal"?"route-normal":"route-good"}

function routeCandidateAnalysis(route){
  const coords=(route?.geometry?.coordinates||[]).map(p=>[p[1],p[0]]);
  const nearby=[];const seen=new Set();const samples=sampleRoutePoints(coords,30);
  samples.forEach((p,index)=>{
    const hit=nearestWeatherRow(p[0],p[1]);
    if(hit){
      const weatherRow=routeWeatherRow(hit.row),key=weatherRow.city+"||"+weatherRow.town;
      if(!seen.has(key)){
        seen.add(key);
        nearby.push({...hit,row:weatherRow,routeSampleIndex:index,routeSampleCount:samples.length,isRouteInterior:index>0&&index<samples.length-1});
      }
    }
  });
  const conditions=nearby.map(x=>x.row.riding||ridingCondition(x.row)).filter(c=>Number.isFinite(c.score));
  const interior=nearby.filter(x=>x.isRouteInterior);
  const interiorConditions=interior.map(x=>x.row.riding||ridingCondition(x.row)).filter(c=>Number.isFinite(c.score));
  const rainLevels=nearby.map(x=>(x.row.riding||ridingCondition(x.row)).rainPenalty||0);
  const pops=nearby.map(x=>x.row.pop).filter(Number.isFinite);
  // 宣紙模式最低避險標準為 Score 3：Score 1～3 都列入中間路段風險評估。
  const badInteriorPoints=interior.filter(x=>{
    const c=x.row.riding||ridingCondition(x.row);
    return Number.isFinite(c.score)&&c.score<=3;
  });
  const severeInteriorPoints=interior.filter(x=>{
    const c=x.row.riding||ridingCondition(x.row);
    return Number.isFinite(c.score)&&c.score<=2;
  });
  return {route,coords,nearby,conditions,interiorConditions,badInteriorPoints,severeInteriorPoints,hasBadInteriorPoints:badInteriorPoints.length>0,
    rainMetric:rainLevels.length?rainLevels.reduce((a,b)=>a+b,0)/rainLevels.length:0,
    maxPop:pops.length?Math.max(...pops):null,minScore:conditions.length?Math.min(...conditions.map(c=>c.score)):null,
    avgScore:conditions.length?conditions.reduce((a,c)=>a+c.score,0)/conditions.length:null};
}
function endpointRiskWarning(from,to){
  const warnings=[];
  [[from,"起點"],[to,"終點"]].forEach(([r,label])=>{
    const c=r?.riding||ridingCondition(r);
    if(Number.isFinite(c.score)&&c.score<=2)warnings.push({label,row:r,condition:c});
  });
  return warnings;
}
function loadRouteHistory(){try{const x=JSON.parse(localStorage.getItem(ROUTE_HISTORY_KEY)||"[]");return Array.isArray(x)?x.slice(0,10):[];}catch(_){return [];}}
function renderRouteHistory(){
  const box=$("#routeHistoryList");if(!box)return;const history=loadRouteHistory();
  if(!history.length){box.innerHTML='<div class="route-history-empty">尚無歷史路線查詢。</div>';return;}
  box.innerHTML=history.map((h,i)=>{const f=h.from||{},t=h.to||{},d=h.time?new Date(h.time):null;const tm=d&&!Number.isNaN(d.getTime())?formatTaiwanDateTime(d):"--";const dateLabel=h.date?formatForecastDate(h.date):"當日";return '<button type="button" class="route-history-item" data-history-index="'+i+'"><div><div class="route-history-route">'+(f.city||"--")+"｜"+(f.town||"--")+" → "+(t.city||"--")+"｜"+(t.town||"--")+'</div><span class="route-history-time">'+tm+'</span></div><span class="route-history-arrow">›</span></button>';}).join("");
  box.querySelectorAll(".route-history-item").forEach(btn=>btn.addEventListener("click",()=>{const h=history[Number(btn.dataset.historyIndex)];if(!h)return;if(h.date){state.routeDate=h.date;const ds=$("#routeDateSelect");if(ds)ds.value=h.date;}const f=findRouteRow((h.from?.city||"")+"||"+(h.from?.town||"")),t=findRouteRow((h.to?.city||"")+"||"+(h.to?.town||""));if(f)setRouteLocation("from",f);if(t)setRouteLocation("to",t);}));
}
function saveRouteHistoryItem(from,to){
  const date=routeDateValue();const key=from.city+"||"+from.town+"=>"+to.city+"||"+to.town+"=>"+date;
  const history=loadRouteHistory().filter(h=>(h.from?.city+"||"+h.from?.town+"=>"+h.to?.city+"||"+h.to?.town+"=>"+(h.date||todayTaiwan()))!==key);
  history.unshift({from:{city:from.city,town:from.town},to:{city:to.city,town:to.town},date,time:Date.now()});
  try{localStorage.setItem(ROUTE_HISTORY_KEY,JSON.stringify(history.slice(0,10)));}catch(_){}
  renderRouteHistory();
}
function routeEndpointPopupHTML(r,icon,label){
  const riding=r.riding||ridingCondition(r);
  return '<div class="weather-popup"><h4>'+r.city+"｜"+r.town+'</h4><div class="weather-temp">'+fmt(r.temperature," °C")+'</div><p>💧 濕度：'+fmt(r.humidity," %")+'</p><p>🌧️ 降雨機率：'+fmt(r.pop," %")+'</p><p>💨 風向：'+(r.windDirection||"--")+'</p><p>💨 風速：'+fmt(r.windSpeed," m/s")+'</p><p><strong>🏍️ 騎乘條件：'+(riding.icon||"")+" "+(riding.label||"--")+'</strong></p><p>評分：'+(Number.isFinite(riding.score)?riding.score:"--")+'</p><p>☔ 雨具建議：'+(riding.rainGear||"--")+'</p><p class="popup-muted">'+(riding.reasons?.length?"主要因素："+riding.reasons.join("、")+"<br>":"")+(riding.advice||"")+'</p></div>';
}
function renderRouteEndpoints(from,to){
  routeEndpointMarkers.forEach(m=>m.remove());routeEndpointMarkers=[];if(!taiwanMap)return;
  [[from,"📍","起點"],[to,"🏁","終點"]].forEach(([r,ico,label])=>{
    if(!r||!Number.isFinite(r.latitude)||!Number.isFinite(r.longitude))return;
    const c=r.riding||ridingCondition(r);
    const m=L.marker([r.latitude,r.longitude],{icon:L.divIcon({className:"route-endpoint-marker",html:"<span>"+ico+"</span>",iconSize:[36,36],iconAnchor:[18,18]}),zIndexOffset:1200}).addTo(taiwanMap);
    m.bindPopup(routeEndpointPopupHTML(r,ico,label));
    routeEndpointMarkers.push(m);
  });
}
function clearRouteEndpoints(){routeEndpointMarkers.forEach(m=>m.remove());routeEndpointMarkers=[];activeRouteEndpoints=null;}
async function searchAvoidanceRoutes(){
  if(!activeRouteEndpoints||routeAvoidanceSearching)return;
  const {from,to}=activeRouteEndpoints,box=$("#routeResult"),button=$("#analyzeRouteBtn"),fast=routeCandidates[0];
  if(!fast)return;
  routeAvoidanceSearching=true;
  if(button)button.disabled=true;
  startRouteLoadingAnimation();
  if(routeLayer){routeLayer.remove();routeLayer=null;}
  clearRouteMotorcycleAnimation();
  if(box){
    box.className="route-result route-normal";
    box.innerHTML='<div class="route-searching"><strong>🧭 宣紙模式搜尋中…</strong><p>正在重新搜尋更廣泛的道路候選，不沿用最快路線的搜尋結果。</p><p class="route-searching-note">🌧️ 我們不趕時間，會多找幾條路，看看哪條比較不容易淋雨。宣紙模式會比最快路線花費更多時間，請稍候。</p></div>';
  }
  try{
    const snapped=await snapRouteEndpoints(from,to),sf=snapped.from,st=snapped.to;
    const direct=sf.longitude+","+sf.latitude+";"+st.longitude+","+st.latitude;
    const anchors=buildBroadRouteAnchors(from,to),routes=[],seenRoutes=new Set();
    const addRoutes=list=>{
      for(const route of list||[]){
        if(routeHasForbiddenNationalMain(route))continue;
        const key=(route.geometry?.coordinates||[]).map(p=>p.join(",")).slice(0,12).join("|");
        if(!key||seenRoutes.has(key))continue;
        seenRoutes.add(key);routes.push(route);
      }
    };
    for(const root of ["https://router.project-osrm.org/","https://routing.openstreetmap.de/routed-car/"]){
      const directRoutes=await requestOsrmRoutes(root+"route/v1/driving/"+direct,"?overview=full&geometries=geojson&steps=true&alternatives=10&continue_straight=false&exclude=motorway",22000);
      addRoutes(directRoutes);
    }
    for(const root of ["https://router.project-osrm.org/","https://routing.openstreetmap.de/routed-car/"]){
      const jobs=anchors.map(anchor=>{
        const coords=sf.longitude+","+sf.latitude+";"+anchor.longitude+","+anchor.latitude+";"+st.longitude+","+st.latitude;
        return requestOsrmRoutes(root+"route/v1/driving/"+coords,"?overview=full&geometries=geojson&steps=true&alternatives=5&continue_straight=false&exclude=motorway",22000);
      });
      for(let i=0;i<jobs.length;i+=3){
        const batch=await Promise.all(jobs.slice(i,i+3));batch.forEach(addRoutes);
      }
    }
    for(const anchor of anchors.slice(0,10)){
      const route=await requestValhallaFlatRoute(sf,st,[anchor]);
      if(route&&!routeHasForbiddenNationalMain(route))addRoutes([route]);
    }
    const pool=routes.map(routeCandidateAnalysis).filter(x=>x.coords.length>1&&x.route.distance>0);
    if(!pool.length)throw new Error("宣紙模式沒有取得可驗證的替代道路候選。");
    const risk=pool.slice().sort((x,y)=>{
      if(x.rainMetric!==y.rainMetric)return x.rainMetric-y.rainMetric;
      const xMax=x.maxPop??Infinity,yMax=y.maxPop??Infinity;
      if(xMax!==yMax)return xMax-yMax;
      const badDiff=x.badInteriorPoints.length-y.badInteriorPoints.length;
      if(badDiff)return badDiff;
      const xMin=x.interiorConditions.length?Math.min(...x.interiorConditions.map(c=>c.score)):99;
      const yMin=y.interiorConditions.length?Math.min(...y.interiorConditions.map(c=>c.score)):99;
      if(xMin!==yMin)return yMin-xMin;
      const severeDiff=(x.severeInteriorPoints?.length||0)-(y.severeInteriorPoints?.length||0);
      if(severeDiff)return severeDiff;
      return x.route.duration-y.route.duration;
    })[0];
    routeCandidates=[fast,risk];
    activeRouteCandidateIndex=1;
    activateRouteCandidate(1);
  }catch(e){
    console.error(e);
    routeCandidates=[fast];
    activeRouteCandidateIndex=0;
    if(box){
      box.className="route-result route-caution";
      box.innerHTML='<strong>宣紙模式搜尋失敗</strong><p class="route-hint">'+e.message+'</p><p class="route-hint">最快路線沒有變更；請再次點選「宣紙模式」重新搜尋。</p>';
    }
    activateRouteCandidate(0);
  }finally{
    routeAvoidanceSearching=false;
    stopRouteLoadingAnimation();
    if(button){button.disabled=false;button.textContent="分析這段路的可騎行性";}
  }
}
function activateRouteCandidate(index){
  const a=routeCandidates[index];if(!a||!activeRouteEndpoints)return;activeRouteCandidateIndex=index;
  const from=activeRouteEndpoints.from,to=activeRouteEndpoints.to,route=a.route,box=$("#routeResult"),fast=routeCandidates[0],avoidanceMode=index===1;
  const endpointWarnings=endpointRiskWarning(from,to);
  const endpointWarningHTML=endpointWarnings.length
    ? '<div class="route-endpoint-warning"><strong>⚠️ 起終點騎乘提醒</strong><div>'+endpointWarnings.map(w=>w.label+"「"+w.row.city+"｜"+w.row.town+"」目前為 "+w.condition.icon+" "+w.condition.label+"（Score "+w.condition.score+" / 5）"+(w.condition.reasons?.length?"，主要因素："+w.condition.reasons.join("、"):"")).join("<br>")+'</div><small>此提醒只針對起點／終點本身，不會因此觸發宣紙模式。</small></div>'
    : "";
  const lvl=avoidanceMode
    ? (a.minScore==null?{level:"normal",label:"資料不足",icon:"🟡"}:routeLevel(a.minScore))
    : {level:"normal",label:"最快路線",icon:"⚡"};
  const decision=avoidanceMode?routeDecision(lvl.level):{icon:"⚡",label:"依預估時間選擇"};
  const worst=a.nearby.filter(x=>Number.isFinite((x.row.riding||ridingCondition(x.row)).score)).reduce((b,x)=>!b||((x.row.riding||ridingCondition(x.row)).score<(b.row.riding||ridingCondition(b.row)).score)?x:b,a.nearby[0]);
  const reasons=[...new Set(a.conditions.flatMap(c=>c.reasons||[]))],minutes=Math.round(route.duration/60),extra=Math.max(0,minutes-Math.round(fast.route.duration/60));
  const hasSaferAlternative=routeCandidates.length>1&&routeCandidates[1]!==fast&&routeCandidates[1].rainMetric<fast.rainMetric;
  const avoidanceUnavoidable=avoidanceMode&&!hasSaferAlternative;
  const rainLabel=a.rainMetric>=3?"高":a.rainMetric>=2?"中高":a.rainMetric>=1?"中":"低";
  box.className="route-result "+(avoidanceMode?routeClass(lvl.level):"route-normal");
  box.innerHTML='<div class="route-result-head"><div class="route-result-title">'+from.city+"｜"+from.town+" → "+to.city+"｜"+to.town+'</div><strong class="route-result-level">'+lvl.icon+" "+lvl.label+'</strong></div><div class="route-policy-badge">'+routeRegionReminder(from,to)+' · 🚫 已啟用：避開高速公路（國道主線全部排除）</div>'+endpointWarningHTML+'<div class="route-options"><button type="button" class="route-option '+(index===0?"active":"")+'" data-route-index="0"><div class="route-option-title"><strong>最快路線</strong><span>⚡</span></div><div class="route-option-meta"><span>'+Math.round(fast.route.duration/60)+' 分鐘</span><span>'+(fast.route.distance/1000).toFixed(1)+' km</span></div><div class="route-option-note">以避開高速公路後的最短預估時間為優先</div></button>'+(routeCandidates[1]
  ? '<button type="button" class="route-option '+(index===1?"active":"")+'" data-route-index="1"><div class="route-option-title"><strong>宣紙模式</strong><span>🌂</span></div><div class="route-option-meta"><span>'+Math.round(routeCandidates[1].route.duration/60)+' 分鐘</span><span>'+(routeCandidates[1].route.distance/1000).toFixed(1)+' km</span><span>最低降雨風險</span></div><div class="route-option-note">我就是不想淋雨，我有的是時間。<br>重新搜尋低降雨風險路線，不在乎多繞一點。</div></button>'
  : '<button type="button" class="route-option" data-route-index="1"><div class="route-option-title"><strong>宣紙模式</strong><span>🧭</span></div><div class="route-option-meta"><span>重新搜尋</span><span>最低降雨風險優先</span></div><div class="route-option-note">我就是不想淋雨，我有的是時間。<br>重新搜尋更廣泛的道路候選，計算會比最快路線久。</div></button>')+'</div><div class="route-score-row"><div class="route-score"><strong>'+(a.minScore==null?"--":a.minScore)+'</strong><span>'+"最差 Score"+'</span></div><div class="route-summary">'+(avoidanceMode
    ? (avoidanceUnavoidable
      ? "目前沒有找到比最快路線更低降雨風險的替代路線，因此維持最快路線。"
      : "宣紙模式取消額外車程限制；優先採用沿線平均降雨風險最低的已驗證路線，再比較最高降雨機率、Score 風險與預估時間。")
    : "本路線僅以避開高速公路後的最短預估時間為選擇依據；騎乘適合度不參與最快路線的選路。")+"<br>依道路路線沿線 "+a.nearby.length+" 個氣象資料點分析。<br><strong>建議："+decision.icon+" "+decision.label+'</strong><br>最需注意路段：'+(worst?worst.row.city+"｜"+worst.row.town:"--")+'</div></div><div class="route-evidence"><div><span>道路距離</span><strong>'+(route.distance/1000).toFixed(1)+' km</strong></div><div><span>預估車程</span><strong>'+minutes+' 分鐘</strong></div><div><span>沿線平均 Score</span><strong>'+(a.avgScore==null?"--":a.avgScore.toFixed(1))+'</strong></div></div><div class="route-reasons">主要因素：'+(reasons.length?reasons.join("、"):"目前沒有明顯不利因素")+'<br><span>沿線最高降雨機率：'+(a.maxPop==null?"--":a.maxPop+" %")+'</span></div><details class="route-points-collapse"><summary>🛣️ 查看沿線 '+a.nearby.length+' 個氣象資料點</summary><div class="route-points-list">'+a.nearby.map((x,i)=>{const r=x.row,c=r.riding||ridingCondition(r);return '<div class="route-point '+routeClass(c.level)+'"><div class="route-point-index">'+(i+1)+'</div><div><div class="route-point-title"><strong>'+r.city+"｜"+r.town+'</strong><span>'+c.icon+" "+c.label+'</span></div><div class="route-point-metrics"><span class="route-point-score">'+(Number.isFinite(c.score)?"Score "+c.score+" / 5":"資料不足")+'</span><span>🌡️ '+fmt(r.temperature," °C")+'</span><span>💧 '+fmt(r.humidity," %")+'</span><span>🌧️ '+fmt(r.pop," %")+'</span><span>💨 '+fmt(r.windSpeed," m/s")+'</span></div><div class="route-point-weather">'+(r.weather||"天氣資料不足")+" · "+(r.windDirection||"風向未知")+'</div></div></div>';}).join("")+'</div></details>';
  box.querySelectorAll(".route-option").forEach(b=>b.addEventListener("click",()=>{
    const routeIndex=Number(b.dataset.routeIndex);
    if(routeIndex===1&&!routeCandidates[1]){searchAvoidanceRoutes();return;}
    activateRouteCandidate(routeIndex);
  }));
  if(taiwanMap){if(routeLayer)routeLayer.remove();routeLayer=L.polyline(a.coords,{color:avoidanceMode?"#60a5fa":"#7dd3fc",weight:5,opacity:.85}).addTo(taiwanMap);taiwanMap.fitBounds(L.latLngBounds(a.coords).pad(.12));renderRouteEndpoints(from,to);startRouteMotorcycleAnimation(a.coords);}
}
function buildDetourWaypoints(from,to){
  const a=[from.latitude,from.longitude],b=[to.latitude,to.longitude],candidates=[];
  const dx=b[1]-a[1],dy=b[0]-a[0];
  for(const ratio of [.2,.35,.5,.65,.8]){
    const lat=a[0]+dy*ratio,lon=a[1]+dx*ratio;
    const nearby=state.rows.filter(r=>Number.isFinite(r.latitude)&&Number.isFinite(r.longitude)&&r.city!==from.city&&r.city!==to.city)
      .map(r=>({r,d:Math.hypot((r.latitude-lat)*1.1,(r.longitude-lon)*Math.cos(lat*Math.PI/180))}))
      .sort((x,y)=>x.d-y.d);
    const pick=nearby[0]?.r;
    if(pick&&!candidates.some(x=>x.city===pick.city&&x.town===pick.town))candidates.push(pick);
  }
  return candidates;
}
function buildBroadRouteAnchors(from,to){
  const points=[],seen=new Set();
  const add=r=>{
    if(!r||!Number.isFinite(r.latitude)||!Number.isFinite(r.longitude))return;
    const key=r.city+"||"+r.town;
    if(seen.has(key))return;
    seen.add(key);points.push(routeLocationObject(r));
  };
  buildDetourWaypoints(from,to).forEach(add);
  const a=[from.latitude,from.longitude],b=[to.latitude,to.longitude],dx=b[1]-a[1],dy=b[0]-a[0];
  for(const ratio of [.12,.24,.36,.48,.60,.72,.84,.92]){
    const lat=a[0]+dy*ratio,lon=a[1]+dx*ratio;
    state.rows.filter(r=>Number.isFinite(r.latitude)&&Number.isFinite(r.longitude)&&r.city!==from.city&&r.city!==to.city)
      .map(r=>({r,d:haversineKm([lat,lon],[r.latitude,r.longitude])}))
      .sort((x,y)=>x.d-y.d).slice(0,2).forEach(x=>add(x.r));
  }
  return points.slice(0,18);
}
async function requestOsrmRoutes(base,query,timeoutMs=18000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const res=await fetch(base+query,{signal:controller.signal});
    const text=await res.text();let data=null;try{data=JSON.parse(text)}catch(_){}
    return res.ok&&data?.code==="Ok"&&Array.isArray(data.routes)?data.routes:[];
  }catch(_){return []}finally{clearTimeout(timer);}
}
async function requestOsrmNearest(base,lat,lon,timeoutMs=12000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const res=await fetch(base+"nearest/v1/driving/"+lon+","+lat+"?number=1",{signal:controller.signal});
    const data=await res.json().catch(()=>null);
    return res.ok&&data?.code==="Ok"&&data?.waypoints?.[0]?.location?data.waypoints[0].location:null;
  }catch(_){return null}finally{clearTimeout(timer);}
}
async function snapRouteEndpoint(row){
  const fixed=fixedRouteOrigin(row);
  const target=fixed||routeLocationObject(row);
  const roots=["https://router.project-osrm.org/","https://routing.openstreetmap.de/routed-car/"];
  for(const root of roots){
    const p=await requestOsrmNearest(root,Number(target.latitude),Number(target.longitude),12000);
    if(p){
      return {
        longitude:Number(p[0]),
        latitude:Number(p[1]),
        city:row.city,
        town:row.town,
        fixedOriginName:target.fixedOriginName||"",
        fixedOriginAddress:target.fixedOriginAddress||""
      };
    }
  }
  return target;
}
async function snapRouteEndpoints(from,to){
  const [a,b]=await Promise.all([snapRouteEndpoint(from),snapRouteEndpoint(to)]);
  return {from:a,to:b};
}
async function requestRouteFromServers(coords,options=""){
  const bases=[
    "https://router.project-osrm.org/",
    "https://routing.openstreetmap.de/routed-car/"
  ];
  for(const root of bases){
    const routes=await requestOsrmRoutes(root+"route/v1/driving/"+coords,options,18000);
    if(routes.length)return routes;
  }
  return [];
}
// isQiduRow 已在固定起點設定區定義，七堵路線一律使用七堵車站作為起點。
async function requestQiduLocalRoutes(from,to){
  const roots=["https://router.project-osrm.org/","https://routing.openstreetmap.de/routed-car/"];
  const qidu=isQiduRow(from)?from:to;
  const qOrigin=fixedRouteOrigin(qidu)||routeLocationObject(qidu);
  const qLat=Number(qOrigin.latitude),qLon=Number(qOrigin.longitude);
  if(!Number.isFinite(qLat)||!Number.isFinite(qLon))return [];

  // 七堵是山谷、交流道與平面道路高度交疊的區域。
  // 策略重點：
  // 1. nearest 只是「優化吸附」，不再是進入七堵策略的必要條件。
  // 2. 先讓 OSRM 產生候選，再由 RideSky 驗證是否含國道主線。
  // 3. 若一般候選全部被國道過濾，再以 exclude=motorway 做第二輪錨點搜尋。
  const anchors=[];
  const radii=[0.008,0.018];
  anchors.push({latitude:qLat,longitude:qLon});
  for(const radius of radii){
    for(let deg=0;deg<360;deg+=45){
      const rad=deg*Math.PI/180;
      anchors.push({
        latitude:qLat+radius*Math.sin(rad),
        longitude:qLon+(radius*Math.cos(rad))/Math.cos(qLat*Math.PI/180)
      });
    }
  }

  const results=[];
  for(const root of roots){
    // nearest 成功時優先使用吸附後道路點；失敗時直接退回原始行政區座標。
    // 這裡刻意不讓 nearest 服務成為七堵路由的硬性依賴。
    const fromOrigin=fixedRouteOrigin(from)||routeLocationObject(from);
    const sf=(await requestOsrmNearest(root,Number(fromOrigin.latitude),Number(fromOrigin.longitude),12000))
      || [Number(fromOrigin.longitude),Number(fromOrigin.latitude)];
    const st=(await requestOsrmNearest(root,Number(to.latitude),Number(to.longitude),12000))
      || [Number(to.longitude),Number(to.latitude)];

    if(!Number.isFinite(sf[0])||!Number.isFinite(sf[1])||!Number.isFinite(st[0])||!Number.isFinite(st[1]))continue;

    const runAnchors=async query=>{
      const jobs=anchors.map(anchor=>{
        const coords=sf[0]+","+sf[1]+";"+anchor.longitude+","+anchor.latitude+";"+st[0]+","+st[1];
        return requestOsrmRoutes(
          root+"route/v1/driving/"+coords,
          query,
          22000
        );
      });
      const batches=[];
      for(let i=0;i<jobs.length;i+=4)batches.push(jobs.slice(i,i+4));
      for(const batch of batches){
        const routeGroups=await Promise.all(batch);
        for(const routes of routeGroups){
          for(const route of routes){
            if(!routeHasForbiddenNationalMain(route))results.push(route);
          }
        }
      }
    };

    // 第一輪：不要先 exclude motorway，保留 OSRM 尋找替代道路的能力，
    // 最後再由 RideSky 自己淘汰國道主線。
    await runAnchors("?overview=full&geometries=geojson&steps=true&alternatives=5&continue_straight=false");
    if(results.length)break;

    // 第二輪：若 OSRM 的 alternatives 幾乎全部被國道主線包住，
    // 再要求引擎本身避開 motorway，搭配七堵周邊錨點重新搜尋。
    await runAnchors("?overview=full&geometries=geojson&steps=true&alternatives=5&continue_straight=false&exclude=motorway");
    if(results.length)break;
  }
  return results;
}
async function requestSnappedAvoidMotorway(from,waypoints,to){
  const roots=["https://router.project-osrm.org/","https://routing.openstreetmap.de/routed-car/"];
  const raw=[from,...waypoints,...[to]];
  for(const root of roots){
    const snapped=[];
    let ok=true;
    for(const r of raw){
      const p=await requestOsrmNearest(root,r.latitude,r.longitude);
      if(!p){ok=false;break;}
      snapped.push(p[0]+","+p[1]);
    }
    if(!ok)continue;
    const query="?overview=full&geometries=geojson&steps=true&alternatives=3&continue_straight=false&exclude=motorway";
    const routes=await requestOsrmRoutes(root+"route/v1/driving/"+snapped.join(";"),query,22000);
    const valid=routes.filter(route=>!routeHasForbiddenNationalMain(route));
    if(valid.length)return {routes:valid,mode:"快速道路／平面道路混合"};
  }
  return {routes:[],mode:""};
}
function decodePolyline6(str){
  let index=0,lat=0,lng=0,out=[];
  while(index<str.length){
    let result=0,shift=0,b;
    do{b=str.charCodeAt(index++)-63;result|=(b&31)<<shift;shift+=5;}while(b>=32);
    lat+=result&1?~(result>>1):result>>1;
    result=0;shift=0;
    do{b=str.charCodeAt(index++)-63;result|=(b&31)<<shift;shift+=5;}while(b>=32);
    lng+=result&1?~(result>>1):result>>1;
    out.push([lat/1e6,lng/1e6]);
  }
  return out;
}
async function requestValhallaFlatRoute(from,to,waypoints=[]){
  const locations=[from,...waypoints,to].map(r=>({lat:r.latitude,lon:r.longitude,type:"break"}));
  const payload={
    locations,
    costing:"motorcycle",
    costing_options:{motorcycle:{use_highways:0,use_trails:0}},
    units:"kilometers",
    directions_options:{units:"kilometers"}
  };
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),22000);
  try{
    const res=await fetch("https://valhalla1.openstreetmap.de/route",{
      method:"POST",
      headers:{"Content-Type":"application/json","X-Client-Id":"ridesky-weather"},
      body:JSON.stringify(payload),
      signal:controller.signal
    });
    const data=await res.json().catch(()=>null);
    const trip=data?.trip;
    if(!res.ok||!trip?.legs?.length||!Array.isArray(trip.legs))return null;
    const coords=[];
    const steps=[];
    for(const leg of trip.legs){
      if(leg.shape){
        const part=decodePolyline6(leg.shape);
        if(part.length)coords.push(...(coords.length?part.slice(1):part));
      }
      for(const m of leg.maneuvers||[]){
        const names=(m.street_names||[]).map(x=>x.value||x.text||String(x)).join(" ");
        const instruction=[m.verbal_pre_transition_instruction,m.verbal_post_transition_instruction].filter(Boolean).join(" ");
        steps.push({name:names,ref:"",destinations:instruction});
      }
    }
    if(coords.length<2)return null;
    const summary=trip.summary||{};
    const route={
      distance:Number(summary.length||0)*1000,
      duration:Number(summary.time||0),
      geometry:{type:"LineString",coordinates:coords.map(p=>[p[1],p[0]])},
      legs:[{steps}]
    };
    if(!route.distance){
      route.distance=coords.reduce((s,p,i)=>i?s+routeDistance([coords[i-1][0],coords[i-1][1]],[p[0],p[1]]):0,0);
    }
    return route;
  }catch(_){return null}finally{clearTimeout(timer);}
}
async function collectFastRouteCandidates(sf,st,waypoints=[]){
  const roots=["https://router.project-osrm.org/","https://routing.openstreetmap.de/routed-car/"];
  const routes=[],seen=new Set();
  const addRoutes=list=>{
    for(const route of list||[]){
      if(routeHasForbiddenNationalMain(route))continue;
      const key=(route.geometry?.coordinates||[]).map(p=>p.join(",")).slice(0,12).join("|");
      if(!key||seen.has(key))continue;
      seen.add(key);routes.push(route);
    }
  };
  const direct=sf.longitude+","+sf.latitude+";"+st.longitude+","+st.latitude;

  // 最快路線第一階段：不要只接受第一個 OSRM 回應。
  // 同時詢問兩個 OSRM 服務，並提高 alternatives，避免較短候選因第一次搜尋集合不足而遺漏。
  await Promise.all(roots.map(async root=>{
    const directRoutes=await requestOsrmRoutes(
      root+"route/v1/driving/"+direct,
      "?overview=full&geometries=geojson&steps=true&alternatives=10&continue_straight=false&exclude=motorway",
      22000
    );
    addRoutes(directRoutes);
  }));

  // 關鍵修正：最快模式與宣紙模式共用「單一廣泛 anchor」候選。
  // 每個 anchor 都獨立測試，避免宣紙模式找到的某一條短路線根本沒有進入最快模式候選池。
  // 這會增加最快模式搜尋時間，但能真正建立「最快 = 候選池中的最短路線」。
  const anchorJobs=waypoints.map(anchor=>Promise.all(roots.map(async root=>{
    const p=await requestOsrmNearest(root,anchor.latitude,anchor.longitude);
    if(!p)return;
    const coords=sf.longitude+","+sf.latitude+";"+p[0]+","+p[1]+";"+st.longitude+","+st.latitude;
    const waypointRoutes=await requestOsrmRoutes(
      root+"route/v1/driving/"+coords,
      "?overview=full&geometries=geojson&steps=true&alternatives=10&continue_straight=false&exclude=motorway",
      22000
    );
    addRoutes(waypointRoutes);
  })));
  for(let i=0;i<anchorJobs.length;i+=3)await Promise.all(anchorJobs.slice(i,i+3));
  return routes;
}
async function analyzeRoute(){
  // 點擊重新規劃的瞬間就清除上一輪結果，避免新舊路線同時留在畫面上。
  clearRouteMotorcycleAnimation();
  if(routeLayer){routeLayer.remove();routeLayer=null;}
  clearRouteEndpoints();
  routeCandidates=[];activeRouteCandidateIndex=0;activeRouteEndpoints=null;
  const box=$("#routeResult");
  if(box){box.className="route-result hidden";box.innerHTML="";}
  const from=findRouteRow($("#routeFrom")?.value),to=findRouteRow($("#routeTo")?.value);
  if(!from||!to){if(box){box.className="route-result";box.innerHTML="<strong>請先選擇起點與終點。</strong>"}return;}
  if(from.city===to.city&&from.town===to.town){if(box){box.className="route-result";box.innerHTML="<strong>起點與終點不能相同。</strong>"}return;}
  const policy=routeRegionPolicy(from,to);
  if(!policy.allowed){
    if(box){box.className="route-result route-normal";box.innerHTML="<strong>目前無法規劃這段道路路線</strong><p class=\"route-hint\">🚢 "+policy.message+"</p><p class=\"route-hint\">目前選擇："+from.city+"｜"+from.town+" → "+to.city+"｜"+to.town+"</p><p class=\"route-hint\">請改選同一島群內的鄉鎮；系統不會嘗試把海運／空運當成道路路線。</p>"}
    return;
  }
  const button=$("#analyzeRouteBtn");
  button.disabled=true;
  startRouteLoadingAnimation();
  try{
    // 重要修正：不再先做「直接點到點」的連通性檢查。
    // 行政區中心點可能不在道路上；先吸附起終點，再進入多引擎、多策略路由。
    const snapped=await snapRouteEndpoints(from,to);
    const sf=snapped.from,st=snapped.to;
    const direct=sf.longitude+","+sf.latitude+";"+st.longitude+","+st.latitude;
    const waypoints=buildBroadRouteAnchors(from,to);
    let valid=[];
    let routingMode="";

    // 1. OSRM：廣泛取得第一輪「最快候選」，再從全部候選中取真正最短者。
    // 不再因第一個 OSRM 已有回應，就提前停止搜尋。
    valid=await collectFastRouteCandidates(sf,st,waypoints);
    if(valid.length)routingMode="快速道路／平面道路";

    // 七堵專用處理：七堵地形與國道／快速道路高度交疊，
    // 若第一輪候選全部無法通過驗證，再啟用七堵專用道路錨點策略。
    if(!valid.length && (isQiduRow(from)||isQiduRow(to))){
      valid=await requestQiduLocalRoutes(from,to);
      if(valid.length)routingMode="七堵平面道路專用策略";
    }

    // 2. Valhalla motorcycle：即使 OSRM 暫時無法服務，也不能因單一引擎失敗就判定無路。
    if(!valid.length){
      const flatPoints=[[],waypoints.slice(0,1),waypoints.slice(0,2),waypoints.slice(0,3)];
      for(const selected of flatPoints){
        const route=await requestValhallaFlatRoute(sf,st,selected);
        if(route&&!routeHasForbiddenNationalMain(route)){valid=[route];routingMode="Valhalla 機車平面道路備援";break;}
      }
    }

    // 4. 最後才允許一般 OSRM route 作為救援，再做國道主線驗證。
    if(!valid.length){
      valid=(await requestRouteFromServers(direct,"?overview=full&geometries=geojson&steps=true&alternatives=5&continue_straight=false"))
        .filter(route=>!routeHasForbiddenNationalMain(route));
      if(valid.length)routingMode="一般道路救援（已驗證無國道主線）";
    }

    // 5. 再以原始行政區中心點做一次 Valhalla；避免 nearest 服務本身故障造成假性失敗。
    if(!valid.length){
      const route=await requestValhallaFlatRoute(from,to,[]);
      if(route&&!routeHasForbiddenNationalMain(route)){valid=[route];routingMode="Valhalla 原始座標救援";}
    }

    if(!valid.length)throw new Error(
  isQiduRow(from)
    ? "七堵目前固定從「七堵車站」出發，但仍沒有取得可驗證的道路路線；請稍後重新分析。"
    : "目前兩個 OSRM 路由服務與 Valhalla 都沒有回傳可驗證的道路路線；請稍後重新分析。"
);

    routeCandidates=valid.map(route=>routeCandidateAnalysis(route)).filter(x=>x.coords.length>1).sort((a,b)=>a.route.duration-b.route.duration);
    const fast=routeCandidates[0];
    if(!fast)throw new Error("路由服務有回應，但沒有可繪製的完整道路幾何。");
    // 最快路線只負責產生並顯示最快候選；宣紙模式會在使用者點擊時重新搜尋。
    routeCandidates=[fast];
    activeRouteCandidateIndex=0;
    activeRouteEndpoints={from,to,routingMode};
    saveRouteHistoryItem(from,to);
    activateRouteCandidate(0);
  }catch(e){
    console.error(e);
    box.className="route-result";
    box.innerHTML="<strong>路線分析暫時失敗</strong><p class=\"route-hint\">"+e.message+"</p><p class=\"route-hint\">系統已依序嘗試：道路端點吸附 → OSRM 避開國道 → 導引點繞行 → Valhalla 機車路由 → OSRM 最終救援。</p>";
  }finally{
    stopRouteLoadingAnimation();
    button.disabled=false;
    button.textContent="分析這段路的可騎行性";
  }
}
function startRouteLoadingAnimation(){
  stopRouteLoadingAnimation();
  const button=$("#analyzeRouteBtn");
  if(!button)return;
  let dots=1;
  const render=()=>{button.textContent="規劃路線中"+".".repeat(dots);dots=dots>=6?1:dots+1;};
  render();
  routeLoadingTimer=setInterval(render,420);
}
function stopRouteLoadingAnimation(){
  if(routeLoadingTimer){clearInterval(routeLoadingTimer);routeLoadingTimer=null;}
}
function clearRoute(){
  clearRouteMotorcycleAnimation();
  if(routeLayer){routeLayer.remove();routeLayer=null;}
  clearRouteEndpoints();routeCandidates=[];activeRouteCandidateIndex=0;
  const from=routeSearchElements("from"),to=routeSearchElements("to");
  [from,to].forEach(e=>{if(!e)return;e.input.value="";e.input.dataset.city="";e.input.dataset.mode="";e.input.dataset.index="-1";e.value.value="";e.suggestions.innerHTML="";e.suggestions.classList.add("hidden");e.townWrap.classList.add("hidden");e.town.innerHTML='<option value="">請先選擇縣市</option>';});
  const box=$("#routeResult");if(box){box.className="route-result hidden";box.innerHTML="";}
  const button=$("#analyzeRouteBtn");if(button){button.disabled=false;button.textContent="分析這段路的可騎行性";}
}
function normalizeDefaultLocation(value){
  if(typeof value==="string"){
    const r=cityRepresentative(value);
    return r?{city:r.city,town:r.town}:null;
  }
  if(!value||!value.city)return null;
  const city=state.rows.find(r=>r.city===value.city);
  if(!city)return null;
  const town=value.town||city.town;
  const r=state.rows.find(row=>row.city===value.city&&row.town===town);
  return r?{city:r.city,town:r.town}:null;
}
function loadDefaults(){
  try{
    const saved=JSON.parse(localStorage.getItem(DEFAULT_KEY)||"[]");
    if(Array.isArray(saved)&&saved.length){
      state.defaultLocations=saved.map(normalizeDefaultLocation).filter(Boolean).slice(0,9);
      return;
    }
    const legacy=JSON.parse(localStorage.getItem(LEGACY_DEFAULT_KEY)||"[]");
    if(Array.isArray(legacy)&&legacy.length){
      state.defaultLocations=legacy.map(normalizeDefaultLocation).filter(Boolean).slice(0,9);
      saveDefaults();
    }
  }catch(_){}
}
function saveDefaults(){
  localStorage.setItem(DEFAULT_KEY,JSON.stringify(state.defaultLocations.slice(0,9)));
  updateDefaultCount();
}
function updateDefaultCount(){
  $("#defaultCount").textContent=state.defaultLocations.length+" / 9";
}
function ensureDefaults(){
  const normalized=state.defaultLocations.map(normalizeDefaultLocation).filter(Boolean);
  state.defaultLocations=normalized.slice(0,9);
  if(!state.defaultLocations.length){
    state.defaultLocations=cities().slice(0,9).map(city=>{
      const r=cityRepresentative(city);
      return r?{city:r.city,town:r.town}:null;
    }).filter(Boolean);
  }
  saveDefaults();
}
function normalizeSearchText(value=""){
  return String(value).trim().replaceAll("臺","台").replaceAll("台灣","台灣");
}
function openDefaultCities(){
  const panel=document.querySelector(".default-cities-collapse");
  if(panel)panel.open=true;
}
function renderSuggestions(){
  const box=$("#suggestions"),q=normalizeSearchText($("#searchInput").value);
  state.suggestionItems=[];state.suggestionIndex=-1;
  if(!q){box.classList.add("hidden");$("#townSelectWrap").classList.add("hidden");return}

  const cityMatches=cities().filter(city=>normalizeSearchText(city).includes(q));
  const townMatches=state.rows.filter(r=>normalizeSearchText(r.town).includes(q));

  // 完整輸入縣市名稱：維持原本行為，顯示該縣市的鄉鎮下拉選單。
  const exactCity=cities().find(city=>normalizeSearchText(city)===q);
  if(exactCity){
    state.selectedCity=exactCity;state.selectedTown="";
    populateTownSelect(exactCity);
    $("#townSelectWrap").classList.remove("hidden");
    $("#searchHint").textContent="已輸入："+exactCity+"，請從下方下拉選單選擇該地區的鄉鎮。";
    box.classList.add("hidden");
    renderCityCards(exactCity);
    openDefaultCities();
    return;
  }

  const items=[];
  const seenCities=new Set();
  cityMatches.forEach(city=>{
    if(seenCities.has(city))return;
    seenCities.add(city);
    items.push({type:"city",city,town:"",name:city,label:"縣市"});
  });

  // 同名鄉鎮可能存在於不同縣市，因此保留每一筆，讓使用者能直接選到正確資料。
  townMatches.forEach(r=>items.push({type:"town",city:r.city,town:r.town,name:r.town,label:"鄉鎮"}));

  state.suggestionItems=items;
  box.innerHTML="";
  items.slice(0,10).forEach((m,i)=>{
    const b=document.createElement("button");
    b.type="button";b.className="suggestion";b.dataset.index=i;
    b.innerHTML="<span>"+m.name+"</span><small>"+m.label+(m.type==="town"?"｜"+m.city:"")+"</small>";
    b.addEventListener("click",()=>selectSearch(m));
    b.addEventListener("mouseenter",()=>setSuggestionIndex(i));
    box.appendChild(b);
  });
  box.classList.toggle("hidden",!items.length);
  $("#townSelectWrap").classList.add("hidden");
}
function setSuggestionIndex(index){
  const visibleCount=Math.min(state.suggestionItems.length,10);
  if(!visibleCount)return;
  state.suggestionIndex=Math.max(0,Math.min(index,visibleCount-1));
  document.querySelectorAll("#suggestions .suggestion").forEach((el,i)=>el.classList.toggle("active",i===state.suggestionIndex));
  const active=document.querySelector("#suggestions .suggestion.active");
  if(active)active.scrollIntoView({block:"nearest"});
}
function handleSearchKeydown(e){
  const box=$("#suggestions");
  if(box.classList.contains("hidden")){
    if(e.key==="ArrowDown"||e.key==="ArrowUp"){
      const q=normalizeSearchText($("#searchInput").value);
      if(q){renderSuggestions();e.preventDefault();}
    }
    return;
  }
  const count=Math.min(state.suggestionItems.length,10);
  if(!count)return;
  if(e.key==="ArrowDown"){
    e.preventDefault();setSuggestionIndex(state.suggestionIndex<0?0:state.suggestionIndex+1);
  }else if(e.key==="ArrowUp"){
    e.preventDefault();setSuggestionIndex(state.suggestionIndex<0?count-1:state.suggestionIndex-1);
  }else if(e.key==="Enter"){
    if(state.suggestionIndex>=0){e.preventDefault();selectSearch(state.suggestionItems[state.suggestionIndex]);}
  }else if(e.key==="Escape"){
    e.preventDefault();box.classList.add("hidden");state.suggestionIndex=-1;
  }
}
function selectSearch(m){
  $("#suggestions").classList.add("hidden");
  state.suggestionIndex=-1;
  state.selectedCity=m.city;
  state.selectedTown=m.town||"";
  $("#searchInput").value=m.type==="town"?m.town:m.city;

  if(m.type==="town"){
    // 搜尋到鄉鎮時直接顯示該筆資料，不需要再選一次縣市。
    $("#townSelectWrap").classList.add("hidden");
    renderTownResult(m.city,m.town);
    openDefaultCities();
    $("#searchHint").textContent="目前顯示："+m.city+"｜"+m.town+"（鄉鎮）。";
    return;
  }

  populateTownSelect(m.city);
  $("#townSelectWrap").classList.remove("hidden");
  $("#searchHint").textContent="已選擇："+m.city+"，請從下方下拉選單選擇該地區的鄉鎮。";
  renderCityCards(m.city);
  openDefaultCities();
  setTimeout(()=>{$("#townSelect").focus();},0);
}
function populateTownSelect(city,selected=""){
  const sel=$("#townSelect");sel.innerHTML='<option value="">請選擇鄉鎮</option>';
  towns(city).forEach(r=>{const o=document.createElement("option");o.value=r.town;o.textContent=r.town;if(r.town===selected)o.selected=true;sel.appendChild(o)});
}
function renderTownResult(city,town){
  const r=selectedRows().find(x=>x.city===city&&x.town===town);if(!r)return;
  state.selectedCity=city;
  state.selectedTown=town;
  openDefaultCities();
  renderRows([r],false);
  $("#searchHint").textContent="目前顯示："+city+"｜"+town+"。選擇其他鄉鎮即可切換。";
}
function renderCityCards(city){openDefaultCities();$("#weatherGrid").innerHTML="";$("#searchHint").textContent="已選擇："+city+"，請從下方下拉選單選擇鄉鎮；選擇後才會顯示該鄉鎮資料。"}
function forecastDays(r){
  const forecast=(r?.forecast||[]).filter(x=>x?.start).sort((a,b)=>new Date(a.start)-new Date(b.start));
  const days=new Map();
  for(const item of forecast){
    const d=new Date(item.start);
    const key=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
    if(!days.has(key))days.set(key,[]);
    days.get(key).push(item);
  }
  return [...days.entries()].slice(0,7).map(([key,items],index)=>{
    const temps=items.map(x=>x.temperature).filter(Number.isFinite);
    const pops=items.map(x=>x.pop).filter(Number.isFinite);
    const hums=items.map(x=>x.humidity).filter(Number.isFinite);
    const winds=items.map(x=>x.windSpeed).filter(Number.isFinite);
    const representativeWeather=items.find(x=>x.weather&&x.weather!=="資料待更新")?.weather||"資料待更新";
    const riding=ridingCondition({
      temperature:temps.length?temps.reduce((a,b)=>a+b,0)/temps.length:null,
      humidity:hums.length?hums.reduce((a,b)=>a+b,0)/hums.length:null,
      pop:pops.length?Math.max(...pops):null,
      windSpeed:winds.length?Math.max(...winds):null,
      weather:representativeWeather
    });
    return {
      key,items,index,
      dateLabel:index===0?"今天":index===1?"明天":index===2?"後天":`第${index+1}天`,
      temp:temps.length?temps.reduce((a,b)=>a+b,0)/temps.length:null,
      minTemp:temps.length?Math.min(...temps):null,
      maxTemp:temps.length?Math.max(...temps):null,
      pop:pops.length?Math.max(...pops):null,
      humidity:hums.length?hums.reduce((a,b)=>a+b,0)/hums.length:null,
      wind:winds.length?Math.max(...winds):null,
      weather:items.find(x=>x.weather&&x.weather!=="資料待更新")?.weather||"資料待更新",
      riding
    };
  });
}
function buildLineChart(days,type){
  const width=720,height=220,pad={l:48,r:24,t:30,b:42};
  const values=days.map(d=>type==="temp"?d.temp:d.pop).map(v=>Number.isFinite(v)?v:null);
  const valid=values.filter(v=>v!==null);
  if(!valid.length)return '<div class="forecast-chart-empty">目前沒有可用資料</div>';
  let min=Math.min(...valid),max=Math.max(...valid);
  if(type==="temp"){min=Math.floor(min-1);max=Math.ceil(max+1);}
  else {min=Math.max(0,Math.floor(min/10)*10);max=Math.min(100,Math.ceil(max/10)*10);if(min===max){min=Math.max(0,min-10);max=Math.min(100,max+10);}}
  if(min===max){min-=1;max+=1;}
  const x=i=>pad.l+(days.length===1?0:i*(width-pad.l-pad.r)/(days.length-1));
  const y=v=>pad.t+(max-v)*(height-pad.t-pad.b)/(max-min);
  const points=values.map((v,i)=>v===null?null:`${x(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean).join(" ");
  const unit=type==="temp"?"°C":"%";
  const title=type==="temp"?"🌡️ 溫度變化":"🌧️ 降雨機率變化";
  const labels=days.map((d,i)=>`<text x="${x(i)}" y="${height-14}" text-anchor="middle" class="forecast-chart-label">${d.dateLabel}</text>`).join("");
  const dots=values.map((v,i)=>v===null?"":`<circle cx="${x(i)}" cy="${y(v)}" r="4" class="forecast-chart-dot"><title>${days[i].dateLabel}：${v.toFixed(0)}${unit}</title></circle>`).join("");
  const guides=[0,.5,1].map(t=>{const value=max-(max-min)*t;return `<line x1="${pad.l}" x2="${width-pad.r}" y1="${y(value)}" y2="${y(value)}" class="forecast-chart-grid"/><text x="${pad.l-9}" y="${y(value)+4}" text-anchor="end" class="forecast-chart-y">${value.toFixed(0)}${unit}</text>`;}).join("");
  return `<div class="forecast-chart"><div class="forecast-chart-title"><strong>${title}</strong><span>7 日趨勢</span></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}"><g>${guides}</g><polyline points="${points}" class="forecast-chart-line" fill="none" stroke-linecap="round" stroke-linejoin="round"></polyline><g>${dots}</g><g>${labels}</g></svg></div>`;
}
function renderThreeDayForecast(container,r){
  container.innerHTML="";
  const days=forecastDays(r);
  if(!days.length){container.innerHTML='<p class="muted">目前沒有可用的 7 日預報資料。</p>';return;}
  container.innerHTML='<div class="forecast-charts">'+buildLineChart(days,"temp")+buildLineChart(days,"pop")+'</div><div class="forecast-day-list">'+
    days.map(d=>'<div class="three-day-item '+(d.riding?.level||"good")+'"><div class="three-day-head"><strong>'+d.dateLabel+'</strong><span>'+d.key+'</span></div><div class="three-day-weather">'+icon(d.weather)+' '+d.weather+'</div><div class="three-day-values"><span>🌡️ '+(d.minTemp!=null?d.minTemp+"–"+d.maxTemp:"--")+' °C</span><span>🌧️ 降雨機率 '+(d.pop!=null?d.pop:"--")+' %</span><span>💧 濕度 '+(d.humidity!=null?d.humidity.toFixed(0):"--")+' %</span><span>💨 最高風速 '+(d.wind!=null?d.wind.toFixed(1):"--")+' m/s</span></div><div class="three-day-riding"><span>🏍️ 騎乘條件</span><strong>'+((d.riding?.icon)||"")+" "+((d.riding?.label)||"資料不足")+(d.riding?.incomplete?"":" · "+(Number.isFinite(d.riding?.score)?d.riding.score:"--")+" / 5")+'</strong></div><div class="three-day-riding-reasons">'+(d.riding?.reasons?.length?d.riding.reasons.join("、"):"目前沒有明顯不利因素")+'</div></div>').join("")+
    '</div>';
}
function bindForecastCollapse(details){
  if(!details)return;
  details.addEventListener("toggle",()=>{
    if(details.open)document.querySelectorAll(".three-day-collapse[open]").forEach(other=>{if(other!==details)other.open=false;});
    const card=details.closest(".weather-card");
    if(!card)return;
    card.classList.toggle("forecast-expanded",details.open);
    if(details.open){
      requestAnimationFrame(()=>{
        const charts=details.querySelectorAll(".forecast-chart");
        charts.forEach((chart,i)=>{
          chart.style.animation="none";
          void chart.offsetWidth;
          chart.style.animation="";
          chart.style.animationDelay=(i*70)+"ms";
        });
      });
    }
  });
}
function renderRows(rows,showAll=false){
  const g=$("#weatherGrid");g.innerHTML="";
  if(!rows.length){g.innerHTML='<div class="source-card"><strong>沒有符合的資料</strong><p>請重新搜尋或清除選擇。</p></div>';return}
  const t=$("#weatherTemplate");
  rows.forEach(r=>{
    const n=t.content.cloneNode(true),check=n.querySelector(".default-check");
    n.querySelector(".city").textContent=r.town;n.querySelector(".town").textContent=r.city;
    n.querySelector(".weather-icon").textContent=icon(r.weather);n.querySelector(".temp").textContent=fmt(r.temperature);
    n.querySelector(".weather-name").textContent=r.weather;n.querySelector(".humidity").textContent=fmt(r.humidity,"%");n.querySelector(".pop").textContent=fmt(r.pop,"%");
    n.querySelector(".wind-direction").textContent=windArrow(r.windDirection)+" "+(r.windDirection||"--");n.querySelector(".wind-speed").textContent=fmt(r.windSpeed," m/s");
    const riding=r.riding||ridingCondition(r);
    const decision=buildDecisionSupport(r);
    const levelEl=n.querySelector(".riding-level");
    const panel=n.querySelector(".riding-panel");
    levelEl.textContent=(riding.icon||"")+" "+(riding.label||"資料不足");
    panel.className="riding-panel riding-"+(riding.level||"unknown");
    n.querySelector(".riding-score-value").textContent=Number.isFinite(riding.score)?riding.score:"--";
    n.querySelector(".riding-reasons-value").textContent=riding.reasons?.length?riding.reasons.join("、"):"目前沒有明顯不利因素";
    n.querySelector(".riding-advice-value").textContent=riding.advice||"請留意最新天氣資訊。";
    const rainGearEl=n.querySelector(".rain-gear-value");
    if(rainGearEl)rainGearEl.textContent=(riding.rainGear||"資料不足")+(riding.rainRisk?"（降雨風險："+riding.rainRisk+"）":"");
    const decisionPanel=n.querySelector(".decision-panel");
    decisionPanel.className="decision-panel decision-"+decision.action.toLowerCase();
    n.querySelector(".decision-action").textContent=decision.actionIcon+" "+decision.actionLabel;
    n.querySelector(".decision-evidence").textContent=decision.evidence.join("、");
    n.querySelector(".forecast-time").textContent=r.start?"預報時間："+formatTaiwanDateTime(r.start):"預報時間：--";
    renderThreeDayForecast(n.querySelector(".three-day-forecast"),r);
    bindForecastCollapse(n.querySelector(".three-day-collapse"));
    const defaultLocation=state.defaultLocations.some(d=>d.city===r.city&&d.town===r.town);
    check.checked=defaultLocation;

    // 預設地區已達 9 筆時，搜尋結果中的「預設」也必須立即鎖定。
    // 已經是預設的項目仍保持可取消，讓使用者可以先釋放名額。
    const defaultLimitReached=state.defaultLocations.length>=9&&!defaultLocation;
    check.disabled=defaultLimitReached;
    if(defaultLimitReached){
      check.title="預設顯示已達 9 個上限，請先取消其他預設地區。";
      check.setAttribute("aria-label",r.city+"｜"+r.town+"：預設顯示已達 9 個上限");
    }else{
      check.removeAttribute("title");
      check.removeAttribute("aria-label");
    }

    check.addEventListener("change",()=>{
      // 再做一次狀態層防護，避免其他觸控／瀏覽器事件繞過 disabled。
      if(check.checked&&!defaultLocation&&state.defaultLocations.length>=9){
        check.checked=false;
        alert("預設顯示最多 9 個地區，請先取消其他預設地區。");
        return;
      }
      toggleDefault(r.city,r.town,check.checked);
    });
    g.appendChild(n);
  });
}
function toggleDefault(city,town,on){
  const key=city+"||"+town;
  if(on){
    if(state.defaultLocations.some(d=>d.city+"||"+d.town===key))return;
    if(state.defaultLocations.length>=9){
      alert("預設顯示最多 9 個地區，請先取消其他預設地區。");
      renderDefaultCards();
      return;
    }
    state.defaultLocations.push({city,town});
  }else{
    state.defaultLocations=state.defaultLocations.filter(d=>d.city!==city||d.town!==town);
  }
  saveDefaults();
  // 預設地區變更後，立即同步地圖上的預設標記與數量。
  if(taiwanMap)renderTaiwanMap();
  if(on&&state.selectedCity===city&&state.selectedTown===town)clearSearch();
  else renderDefaultCards();
}
function renderDefaultCards(){
  const rows=selectedRows(state.defaultLocations.map(d=>state.rows.find(r=>r.city===d.city&&r.town===d.town)).filter(Boolean));
  renderRows(rows,true);
  $("#searchHint").textContent="勾選「預設」即可讓該縣市／鄉鎮在下次開啟網頁時自動出現；最多 9 個。";
}
function clearSearch(){
  state.selectedCity="";state.suggestionItems=[];state.suggestionIndex=-1;state.selectedTown="";$("#searchInput").value="";$("#townSelect").innerHTML='<option value="">請先選擇縣市</option>';$("#townSelectWrap").classList.add("hidden");$("#suggestions").classList.add("hidden");renderDefaultCards();
}
function summary(){
  const ts=state.rows.map(r=>r.temperature).filter(Number.isFinite),hs=state.rows.map(r=>r.humidity).filter(Number.isFinite);
  $("#cityCount").textContent=cities().length;$("#recordCount").textContent=state.rows.length;
  $("#avgTemp").textContent=ts.length?(ts.reduce((a,b)=>a+b,0)/ts.length).toFixed(1)+" °C":"--";
  $("#avgHumidity").textContent=hs.length?(hs.reduce((a,b)=>a+b,0)/hs.length).toFixed(1)+" %":"--";
}
let taiwanMap=null;
let weatherMarkers=[];
let routeEndpointMarkers=[];
let routeLayer=null;
let routeCandidates=[];
let activeRouteCandidateIndex=0;
let activeRouteEndpoints=null;
let routeAvoidanceSearching=false;
const ROUTE_HISTORY_KEY="rideskyRouteHistoryV1";
let routeMotorcycleMarker=null;
let routeAnimationFrame=null;
let routeAnimationRestartTimer=null;
let routeAnimationToken=0;

function clearRouteMotorcycleAnimation(){
  routeAnimationToken++;
  if(routeAnimationFrame!=null)cancelAnimationFrame(routeAnimationFrame);
  routeAnimationFrame=null;
  if(routeAnimationRestartTimer!=null)clearTimeout(routeAnimationRestartTimer);
  routeAnimationRestartTimer=null;
  if(routeMotorcycleMarker&&taiwanMap){
    taiwanMap.removeLayer(routeMotorcycleMarker);
  }
  routeMotorcycleMarker=null;
}

function routeDistance(a,b){
  const R=6371000,rad=Math.PI/180;
  const dLat=(b[0]-a[0])*rad,dLng=(b[1]-a[1])*rad;
  const x=Math.sin(dLat/2)**2+Math.cos(a[0]*rad)*Math.cos(b[0]*rad)*Math.sin(dLng/2)**2;
  return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}

function routeBearing(a,b){
  const rad=Math.PI/180;
  const lat1=a[0]*rad,lat2=b[0]*rad,dLng=(b[1]-a[1])*rad;
  const y=Math.sin(dLng)*Math.cos(lat2);
  const x=Math.cos(lat1)*Math.sin(lat2)-Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLng);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}

function startRouteMotorcycleAnimation(coords){
  clearRouteMotorcycleAnimation();
  if(!taiwanMap||!Array.isArray(coords)||coords.length<2)return;
  const token=routeAnimationToken,points=[];let total=0;
  for(let i=0;i<coords.length;i++){if(i>0)total+=routeDistance(coords[i-1],coords[i]);points.push({lat:coords[i][0],lng:coords[i][1],distance:total});}
  if(total<=0)return;
  const icon=L.divIcon({className:"route-motorcycle-marker",html:"<span>🏍️</span>",iconSize:[34,34],iconAnchor:[17,17]});
  routeMotorcycleMarker=L.marker([points[0].lat,points[0].lng],{icon,zIndexOffset:1000,interactive:false}).addTo(taiwanMap);
  const duration=Math.min(30000,Math.max(7000,total/90*1000));
  let start=performance.now(),phase="forward";
  function setPoint(target){
    let i=1;while(i<points.length&&points[i].distance<target)i++;if(i>=points.length)i=points.length-1;
    const a=points[i-1],b=points[i],span=Math.max(1,b.distance-a.distance),local=Math.min(1,Math.max(0,(target-a.distance)/span));
    routeMotorcycleMarker.setLatLng([a.lat+(b.lat-a.lat)*local,a.lng+(b.lng-a.lng)*local]);
    const bearing=routeBearing([a.lat,a.lng],[b.lat,b.lng]),el=routeMotorcycleMarker.getElement()?.querySelector("span");
    if(el)el.style.transform="rotate("+(bearing+90)+"deg)";
  }
  function flyBack(now){
    const progress=Math.min(1,(now-start)/1200),eased=progress<.5?2*progress*progress:1-Math.pow(-2*progress+2,2)/2;
    const end=points[points.length-1],first=points[0];
    routeMotorcycleMarker.setLatLng([end.lat+(first.lat-end.lat)*eased,end.lng+(first.lng-end.lng)*eased]);
    const el=routeMotorcycleMarker.getElement()?.querySelector("span");if(el)el.style.transform="rotate(-90deg) scale("+(1+0.08*Math.sin(progress*Math.PI))+")";
    if(progress<1){routeAnimationFrame=requestAnimationFrame(flyBack);return;}
    routeAnimationFrame=null;routeMotorcycleMarker.setLatLng([first.lat,first.lng]);phase="forward";start=performance.now();routeAnimationFrame=requestAnimationFrame(frame);
  }
  function frame(now){
    if(token!==routeAnimationToken||!routeMotorcycleMarker)return;
    if(phase==="return"){flyBack(now);return;}
    const progress=Math.min(1,(now-start)/duration);setPoint(total*progress);
    if(progress<1){routeAnimationFrame=requestAnimationFrame(frame);return;}
    routeAnimationFrame=null;setPoint(total);
    routeAnimationRestartTimer=setTimeout(()=>{routeAnimationRestartTimer=null;if(token!==routeAnimationToken||!routeMotorcycleMarker)return;phase="return";start=performance.now();routeAnimationFrame=requestAnimationFrame(frame);},5000);
  }
  routeAnimationFrame=requestAnimationFrame(frame);
}
function weatherMarkerStyle(r){
  const riding=r?.riding||ridingCondition(r);
  const level=riding?.level||"normal";
  const styles={
    good:{fillColor:"#22c55e",color:"#bbf7d0"},
    normal:{fillColor:"#facc15",color:"#fef08a"},
    caution:{fillColor:"#f97316",color:"#fed7aa"},
    high:{fillColor:"#ef4444",color:"#fecaca"}
  };
  const style=styles[level]||styles.normal;
  return {radius:8,...style};
}

function cartoKeyUrl(url,key){
  const separator=url.includes("?")?"&":"?";
  return url+separator+"key="+encodeURIComponent(key);
}

function customizeRideSkyStyle(style,key){
  const custom=JSON.parse(JSON.stringify(style));
  custom.name="RideSky Vector Basemap";
  custom.sources=custom.sources||{};
  Object.values(custom.sources).forEach(source=>{
    if(source&&typeof source.url==="string")source.url=cartoKeyUrl(source.url,key);
  });
  if(custom.sprite)custom.sprite=cartoKeyUrl(custom.sprite,key);
  if(custom.glyphs)custom.glyphs=cartoKeyUrl(custom.glyphs,key);

  const colors={
    background:"#071522",
    land:"#0b1d2b",
    park:"#0d2631",
    water:"#0a2f4a",
    waterway:"#1c6682",
    boundary:"#29485e",
    motorway:"#6f9bb5",
    trunk:"#5f8ca6",
    primary:"#4f7890",
    secondary:"#3c5e73",
    tertiary:"#304d61",
    minor:"#263f52",
    service:"#203747",
    path:"#24485d",
    rail:"#35566b",
    building:"#102536",
    text:"#b9d3e2",
    textStrong:"#d8e8f2",
    textHalo:"#071522"
  };

  for(const layer of custom.layers||[]){
    const sourceLayer=layer["source-layer"]||"";
    const id=String(layer.id||"");
    const filter=JSON.stringify(layer.filter||[]);
    layer.paint=layer.paint||{};

    if(layer.type==="background"){
      layer.paint["background-color"]=colors.background;
      continue;
    }

    if(layer.type==="fill"||layer.type==="fill-extrusion"){
      if(sourceLayer==="water")layer.paint["fill-color"]=colors.water;
      else if(sourceLayer==="landcover"||sourceLayer==="park")layer.paint["fill-color"]=colors.park;
      else if(sourceLayer==="landuse")layer.paint["fill-color"]=colors.land;
      else if(sourceLayer==="building")layer.paint["fill-color"]=colors.building;
      continue;
    }

    if(layer.type==="line"){
      if(sourceLayer==="waterway")layer.paint["line-color"]=colors.waterway;
      else if(sourceLayer==="boundary"){
        layer.paint["line-color"]=colors.boundary;
        layer.paint["line-opacity"]=0.55;
      }else if(sourceLayer==="transportation"){
        let road=colors.minor;
        if(filter.includes('"motorway"'))road=colors.motorway;
        else if(filter.includes('"trunk"'))road=colors.trunk;
        else if(filter.includes('"primary"'))road=colors.primary;
        else if(filter.includes('"secondary"'))road=colors.secondary;
        else if(filter.includes('"tertiary"'))road=colors.tertiary;
        else if(filter.includes('"service"'))road=colors.service;
        else if(filter.includes('"path"'))road=colors.path;
        else if(filter.includes('"rail"'))road=colors.rail;
        if(id.includes("_case"))road="#12293a";
        layer.paint["line-color"]=road;
      }else if(sourceLayer==="aeroway"){
        layer.paint["line-color"]="#29485e";
      }
      continue;
    }

    if(layer.type==="symbol"){
      if(layer.paint["text-color"]!==undefined)layer.paint["text-color"]=sourceLayer==="place"?colors.textStrong:colors.text;
      if(layer.paint["text-halo-color"]!==undefined)layer.paint["text-halo-color"]=colors.textHalo;
      if(layer.paint["icon-color"]!==undefined)layer.paint["icon-color"]="#6f93a8";
      if(sourceLayer==="poi"){
        if(layer.paint["text-opacity"]===undefined)layer.paint["text-opacity"]=0.62;
        if(layer.paint["icon-opacity"]===undefined)layer.paint["icon-opacity"]=0.55;
      }
    }
  }
  return custom;
}

let mapLibrePromise=null;
function loadMapLibreAssets(){
  if(window.maplibregl&&L.maplibreGL)return Promise.resolve();
  if(mapLibrePromise)return mapLibrePromise;
  mapLibrePromise=new Promise((resolve,reject)=>{
    const css=document.createElement("link");
    css.rel="stylesheet";
    css.href="https://unpkg.com/maplibre-gl@5.12.0/dist/maplibre-gl.css";
    document.head.appendChild(css);

    const mapScript=document.createElement("script");
    mapScript.src="https://unpkg.com/maplibre-gl@5.12.0/dist/maplibre-gl.js";
    mapScript.onload=()=>{
      const bridge=document.createElement("script");
      bridge.src="https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.3/leaflet-maplibre-gl.js";
      bridge.onload=resolve;
      bridge.onerror=()=>reject(new Error("MapLibre Leaflet 整合套件載入失敗。"));
      document.head.appendChild(bridge);
    };
    mapScript.onerror=()=>reject(new Error("MapLibre GL 載入失敗。"));
    document.head.appendChild(mapScript);
  });
  return mapLibrePromise;
}

async function getRideSkyVectorStyle(key){
  const cacheKey="rideskyVectorStyleV1";
  try{
    const cached=JSON.parse(localStorage.getItem(cacheKey)||"null");
    if(cached?.style?.version&&cached?.savedAt&&Date.now()-cached.savedAt<86400000){
      return customizeRideSkyStyle(cached.style,key);
    }
  }catch(_){}
  const styleUrl=cartoKeyUrl("https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",key);
  const response=await fetch(styleUrl,{cache:"force-cache"});
  if(!response.ok)throw new Error("CARTO Vector Basemap 載入失敗（HTTP "+response.status+"）。");
  const style=await response.json();
  try{localStorage.setItem(cacheKey,JSON.stringify({savedAt:Date.now(),style}));}catch(_){}
  return customizeRideSkyStyle(style,key);
}

async function initTaiwanMap(){
  if(taiwanMap||typeof L==="undefined")return;
  const key=loadCartoBasemapKey();
  await loadMapLibreAssets();
  const style=await getRideSkyVectorStyle(key);

  taiwanMap=L.map("taiwanMap",{
    zoomControl:true,
    preferCanvas:true,
    minZoom:5,
    maxZoom:18,
    maxBounds:[[21.5,118.0],[26.5,123.0]],
    maxBoundsViscosity:0.9
  }).setView([23.7,121.0],7);

  L.maplibreGL({
    style,
    interactive:false,
    attribution:"&copy; OpenStreetMap contributors, &copy; CARTO"
  }).addTo(taiwanMap);
}

let mapLoadScheduled=false;
function lazyLoadTaiwanMap(){
  if(mapLoadScheduled||taiwanMap)return;
  mapLoadScheduled=true;
  const target=document.getElementById("taiwanMap");
  if(!target){
    mapLoadScheduled=false;
    return;
  }
  if("IntersectionObserver" in window){
    const observer=new IntersectionObserver(entries=>{
      if(entries.some(entry=>entry.isIntersecting)){
        observer.disconnect();
        renderTaiwanMap();
      }
    },{rootMargin:"600px 0px"});
    observer.observe(target);
  }else{
    setTimeout(()=>renderTaiwanMap(),300);
  }
}

async function renderTaiwanMap(){
  try{
    await initTaiwanMap();
  }catch(error){
    console.error("RideSky Vector Basemap 載入失敗",error);
    $("#mapCount").textContent="地圖載入失敗，請稍後重試";
    return;
  }
  if(!taiwanMap)return;
  weatherMarkers.forEach(m=>m.remove());
  weatherMarkers=[];
  const defaults=selectedRows(state.defaultLocations.map(d=>state.rows.find(r=>r.city===d.city&&r.town===d.town)).filter(r=>r&&Number.isFinite(r.latitude)&&Number.isFinite(r.longitude)));
  $("#mapCount").textContent=defaults.length+" 個預設地區";
  defaults.forEach(r=>{
    const s=weatherMarkerStyle(r);
    const riding=r.riding||ridingCondition(r);
    const marker=L.circleMarker([r.latitude,r.longitude],{
      radius:s.radius,fillColor:s.fillColor,color:s.color,weight:1.5,fillOpacity:.82
    }).addTo(taiwanMap);
    marker.bindPopup('<div class="weather-popup"><h4>'+r.city+"｜"+r.town+'</h4><div class="weather-temp">'+fmt(r.temperature," °C")+'</div><p>💧 濕度：'+fmt(r.humidity," %")+'</p><p>🌧️ 降雨機率：'+fmt(r.pop," %")+'</p><p>💨 風向：'+(r.windDirection||"--")+'</p><p>💨 風速：'+fmt(r.windSpeed," m/s")+'</p><p><strong>🏍️ 騎乘條件：'+(riding.icon||"")+" "+(riding.label||"--")+'</strong></p><p>評分：'+(Number.isFinite(riding.score)?riding.score:"--")+'</p><p>☔ 雨具建議：'+(riding.rainGear||"--")+'</p><p class="popup-muted">'+(riding.reasons?.length?"主要因素："+riding.reasons.join("、")+"<br>":"")+(riding.advice||"")+'</p></div>');
    weatherMarkers.push(marker);
  });
  if(defaults.length){
    const bounds=L.latLngBounds(defaults.map(r=>[r.latitude,r.longitude]));
    taiwanMap.fitBounds(bounds.pad(.12));
  }else{
    taiwanMap.setView([23.7,121.0],7);
  }
  if(activeRouteEndpoints)renderRouteEndpoints(activeRouteEndpoints.from,activeRouteEndpoints.to);
  setTimeout(()=>taiwanMap.invalidateSize(),100);
}

function status(a,b){$("#statusTitle").textContent=a;$("#statusText").textContent=b}
async function loadWeather(){
  status("正在取得資料…","正在透過網站後端連線至中央氣象署。");
  const statusEl=$("#refreshStatus"),actionEl=$("#refreshAction");
  actionEl.disabled=true;
  statusEl.textContent="取得資料中......";
  statusEl.classList.remove("is-success");
  try{
    const res=await fetch(API_URL),data=await res.json().catch(()=>null);
    if(!res.ok)throw new Error(data?.message||data?.result?.message||("HTTP "+res.status));
    if(data?.success===false)throw new Error(data?.result?.message||data?.message||"CWA API 回傳錯誤");
    state.rows=parseRows(data);
    // 日期選單直接使用 API 明確提供的 7 個預報日期；若舊版 API 尚未提供，
    // 再從實際回傳的 SQLite forecast rows 推導，避免日期選單空白。
    const apiDates=Array.isArray(data?.meta?.forecastDates)
      ? data.meta.forecastDates.map(String).filter(Boolean)
      : [];
    const rowDates=[...new Set(
      state.rows.flatMap(r=>(r.forecast||[]).map(item=>taiwanDateKey(item.start))).filter(Boolean)
    )].sort();
    const fallbackDates=apiDates.length===7?apiDates:rowDates.slice(-7);
    state.forecastDates=fallbackDates.length===7?fallbackDates:[];
    if(!state.forecastDates.length){
      console.warn("預報日期建立失敗：API meta 與 SQLite rows 都沒有 7 個有效日期。",{
        apiDates,rowDates
      });
    }
    populateForecastDateSelect();
    populateRouteDateSelect();
    if(!state.rows.length)throw new Error("API 有回應，但沒有可顯示的預報資料。");
    loadDefaults();ensureDefaults();summary();renderDefaultCards();populateRouteSelects();populateRouteDateSelect();
    lazyLoadTaiwanMap();
    $("#updatedAt").textContent=formatTaiwanDateTime(new Date());
    status("資料取得成功","目前取得 "+state.rows.length+" 筆鄉鎮資料，可搜尋縣市或鄉鎮。");
    statusEl.textContent="取得成功 ✓";
    statusEl.classList.add("is-success");
    actionEl.disabled=false;
    actionEl.textContent="重新取得資料";
    clearTimeout(window.__refreshButtonTimer);
    window.__refreshButtonTimer=setTimeout(()=>{
      statusEl.textContent="取得成功 ✓";
      statusEl.classList.remove("is-success");
      actionEl.disabled=false;
      actionEl.textContent="重新取得資料";
    },5000);
  }catch(e){
    console.error(e);
    status("取得資料失敗",e.message);
    statusEl.textContent="取得失敗";
    statusEl.classList.remove("is-success");
    actionEl.disabled=false;
    actionEl.textContent="重新取得資料";
  }
}
$("#refreshAction").addEventListener("click",loadWeather);
$("#searchInput").addEventListener("input",renderSuggestions);
$("#searchInput").addEventListener("keydown",handleSearchKeydown);
$("#townSelect").addEventListener("change",e=>{
  if(!state.selectedCity)return;
  if(e.target.value){
    renderTownResult(state.selectedCity,e.target.value);
    openDefaultCities();
  }else renderCityCards(state.selectedCity);
});
$("#clearSearchBtn").addEventListener("click",clearSearch);
$("#forecastDateSelect").addEventListener("change",e=>{
  state.selectedDate=e.target.value||todayTaiwan();
  refreshSelectedDateView();
});
$("#routeDateSelect").addEventListener("change",e=>{state.routeDate=e.target.value||todayTaiwan();if(activeRouteEndpoints)analyzeRoute();});
$("#analyzeRouteBtn").addEventListener("click",analyzeRoute);
$("#clearRouteBtn").addEventListener("click",clearRoute);
renderRouteHistory();
document.addEventListener("click",e=>{if(!e.target.closest(".search-field"))$("#suggestions").classList.add("hidden")});
window.addEventListener("load",loadWeather);